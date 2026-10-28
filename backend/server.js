const express = require("express");
const cors = require("cors");

const {
    EC2Client,
    DescribeImagesCommand,
    DescribeInstancesCommand,
    DescribeKeyPairsCommand,
    DescribeSecurityGroupsCommand,
    DescribeSubnetsCommand,
    RunInstancesCommand,
    CreateTagsCommand
} = require("@aws-sdk/client-ec2");

const app = express();

const PORT = 5000;
const REGION = "ap-south-1";

app.use(cors());
app.use(express.json());

const ec2 = new EC2Client({
    region: REGION
});


// ===============================
// HEALTH CHECK
// ===============================

app.get("/api/health", (req, res) => {

    res.json({
        success: true,
        message: "CloudForge API is running",
        region: REGION
    });

});


// ===============================
// GET ALL EC2 INSTANCES
// ===============================

app.get("/api/instances", async (req, res) => {

    try {

        const command = new DescribeInstancesCommand({});

        const result = await ec2.send(command);

        const instances = [];

        for (const reservation of result.Reservations || []) {

            for (const instance of reservation.Instances || []) {

                const nameTag = instance.Tags?.find(
                    tag => tag.Key === "Name"
                );

                instances.push({

                    id: instance.InstanceId,

                    name: nameTag
                        ? nameTag.Value
                        : "Unnamed",

                    state: instance.State?.Name,

                    type: instance.InstanceType,

                    privateIp:
                        instance.PrivateIpAddress || "-",

                    publicIp:
                        instance.PublicIpAddress || "-",

                    ami:
                        instance.ImageId,

                    launchTime:
                        instance.LaunchTime

                });

            }

        }

        res.json({
            success: true,
            count: instances.length,
            instances
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({

            success: false,
            message: error.message

        });

    }

});


// ===============================
// GET AMIs
// ===============================

app.get("/api/amis", async (req, res) => {

    try {

        const command = new DescribeImagesCommand({

            Owners: ["self"]

        });

        const result = await ec2.send(command);

        const amis = (result.Images || []).map(image => ({

            id:
                image.ImageId,

            name:
                image.Name || "Unnamed AMI",

            state:
                image.State,

            architecture:
                image.Architecture,

            rootDevice:
                image.RootDeviceType,

            creationDate:
                image.CreationDate

        }));

        res.json({

            success: true,

            count: amis.length,

            amis

        });

    } catch (error) {

        console.error(error);

        res.status(500).json({

            success: false,

            message: error.message

        });

    }

});


// ===============================
// GET KEY PAIRS
// ===============================

app.get("/api/keypairs", async (req, res) => {

    try {

        const command = new DescribeKeyPairsCommand({});

        const result = await ec2.send(command);

        const keypairs = (result.KeyPairs || []).map(key => ({
            id: key.KeyPairId,
            name: key.KeyName,
            fingerprint: key.KeyFingerprint
        }));

        res.json({
            success: true,
            count: keypairs.length,
            keypairs
        });

    } catch (error) {

        console.error("Key Pair Error:", error);

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

});

// ===============================
// GET SECURITY GROUPS
// ===============================

app.get("/api/security-groups", async (req, res) => {

    try {

        const command = new DescribeSecurityGroupsCommand({});

        const result = await ec2.send(command);

        const securityGroups = (result.SecurityGroups || []).map(group => ({
            id: group.GroupId,
            name: group.GroupName,
            description: group.Description,
            vpcId: group.VpcId
        }));

        res.json({
            success: true,
            count: securityGroups.length,
            securityGroups
        });

    } catch (error) {

        console.error("Security Group Error:", error);

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

});

// ===============================
// GET SUBNETS
// ===============================

app.get("/api/subnets", async (req, res) => {

    try {

        const command = new DescribeSubnetsCommand({});

        const result = await ec2.send(command);

        const subnets = (result.Subnets || []).map(subnet => ({
            id: subnet.SubnetId,
            name:
                subnet.Tags?.find(tag => tag.Key === "Name")?.Value
                || subnet.SubnetId,
            vpcId: subnet.VpcId,
            cidr: subnet.CidrBlock,
            availabilityZone: subnet.AvailabilityZone,
            availableIpCount: subnet.AvailableIpAddressCount,
            state: subnet.State
        }));

        res.json({
            success: true,
            count: subnets.length,
            subnets
        });

    } catch (error) {

        console.error("Subnet Error:", error);

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

});

// ===============================
// LAUNCH EC2 FROM AMI
// ===============================

app.post("/api/ec2/launch", async (req, res) => {

    try {

        const {
            amiId,
            instanceType,
            name,
            keyName,
            securityGroupId,
            subnetId
        } = req.body;


        // Validate

        if (!amiId) {

            return res.status(400).json({

                success: false,
                message: "AMI ID is required"

            });

        }

        if (!instanceType) {

            return res.status(400).json({

                success: false,
                message: "Instance type is required"

            });

        }

        if (!name) {

            return res.status(400).json({

                success: false,
                message: "Instance name is required"

            });

        }


        // Validate AMI
        const amiData = await ec2.send(
            new DescribeImagesCommand({
                ImageIds: [amiId]
            })
        );

        if (!amiData.Images?.length) {
            return res.status(400).json({
                success: false,
                message: `AMI ${amiId} was not found`
            });
        }

        if (amiData.Images[0].State !== "available") {
            return res.status(400).json({
                success: false,
                message: `AMI ${amiId} is not available`
            });
        }

        // Validate key pair
        if (keyName) {
            const keyData = await ec2.send(
                new DescribeKeyPairsCommand({
                    KeyNames: [keyName]
                })
            );

            if (!keyData.KeyPairs?.length) {
                return res.status(400).json({
                    success: false,
                    message: `Key pair ${keyName} was not found`
                });
            }
        }

        // Validate subnet
        let subnet;

        if (subnetId) {
            const subnetData = await ec2.send(
                new DescribeSubnetsCommand({
                    SubnetIds: [subnetId]
                })
            );

            if (!subnetData.Subnets?.length) {
                return res.status(400).json({
                    success: false,
                    message: `Subnet ${subnetId} was not found`
                });
            }

            subnet = subnetData.Subnets[0];
        }

        // Validate security group
        let securityGroup;

        if (securityGroupId) {
            const sgData = await ec2.send(
                new DescribeSecurityGroupsCommand({
                    GroupIds: [securityGroupId]
                })
            );

            if (!sgData.SecurityGroups?.length) {
                return res.status(400).json({
                    success: false,
                    message: `Security group ${securityGroupId} was not found`
                });
            }

            securityGroup = sgData.SecurityGroups[0];
        }

        // Make sure subnet and security group use same VPC
        if (
            subnet &&
            securityGroup &&
            subnet.VpcId !== securityGroup.VpcId
        ) {
            return res.status(400).json({
                success: false,
                message: "Subnet and security group belong to different VPCs"
            });
        }

        // EC2 configuration
        const params = {
            ImageId: amiId,
            InstanceType: instanceType,
            MinCount: 1,
            MaxCount: 1
        };

        if (keyName) {
            params.KeyName = keyName;
        }

        if (securityGroupId) {
            params.SecurityGroupIds = [securityGroupId];
        }

        if (subnetId) {
            params.SubnetId = subnetId;
        }

        // AWS dry run - verifies permissions/configuration
        try {
            await ec2.send(
                new RunInstancesCommand({
                    ...params,
                    DryRun: true
                })
            );
        } catch (dryRunError) {
            if (dryRunError.name !== "DryRunOperation") {
                throw dryRunError;
            }
        }

        // REAL EC2 launch
        const command =
            new RunInstancesCommand(params);

        const result =
            await ec2.send(command);

        const instance =
            result.Instances?.[0];

        if (!instance) {
            throw new Error(
                "AWS did not return an instance"
            );
        }

        // Add CloudForge tags to the new EC2 instance
        await ec2.send(
            new CreateTagsCommand({
                Resources: [instance.InstanceId],
                Tags: [
                    {
                        Key: "Name",
                        Value: name || "CloudForge-Instance"
                    },
                    {
                        Key: "Project",
                        Value: "CloudForge"
                    }
                ]
            })
        );

        res.json({

            success: true,

            message:
                "EC2 instance launch initiated",

            instance: {

                id:
                    instance.InstanceId,

                state:
                    instance.State?.Name,

                type:
                    instance.InstanceType,

                ami:
                    instance.ImageId

            }

        });


    } catch (error) {

        console.error(
            "EC2 Launch Error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                error.message

        });

    }

});


// ===============================
// START SERVER
// ===============================

app.listen(PORT, "0.0.0.0", () => {

    console.log(
        `CloudForge API running on port ${PORT}`
    );

});
