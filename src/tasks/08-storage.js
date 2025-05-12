/**
 * Task to create the TrueNAS Scale VM with boot and storage volumes
 */
const openstackController = require('../controllers/openstack');
const logger = require('../utils/logger');

/**
 * Main task function to create the TrueNAS Scale VM
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} - Created VM, volumes, and floating IP
 */
const run = async (config) => {
	try {
		logger.start('Creating TrueNAS Scale VM with boot and storage volumes (using SSH initialization)');

		// Authenticate with OpenStack
		await openstackController.authenticate(config.openstack.auth);

		// Get network and create security groups
		const network = await openstackController.getNetwork(config.openstack.network.name);

		const securityGroups = [];
		for (const sgName of config.openstack.vms.storage.security_groups) {
			const sgConfig = config.openstack.security_groups.find((sg) => sg.name === sgName);
			if (!sgConfig) {
				throw new Error(`Security group configuration for ${sgName} not found`);
			}
			const securityGroup = await openstackController.createSecurityGroup(sgConfig);
			securityGroups.push(securityGroup);
		}

		// Get subnet
		const subnetsResponse = await openstackController._client.Network.subnetsGet();
		const subnets = subnetsResponse.data.subnets;
		const subnet = subnets.find((s) => s.name === config.openstack.vms.storage.subnet);
		if (!subnet) {
			throw new Error(`Subnet ${config.openstack.vms.storage.subnet} not found`);
		}

		// Create resources object
		const resources = {
			network,
			securityGroups,
			subnets: [subnet],
		};

		// Calculate IP based on subnet CIDR
		const cidrBase = subnet.cidr.split('/')[0].split('.');
		cidrBase[3] = '10';
		const ip = cidrBase.join('.');

		// Check for existing boot volume and use it if already configured
		logger.info('Checking for existing boot volume for TrueNAS Scale');
		const existingVolumes = await openstackController.getVolumes({
			name: `${config.openstack.vms.storage.name}-boot`,
		});

		let bootVolume = null;
		let bootVolumeIsConfigured = false;

		if (existingVolumes && existingVolumes.length > 0) {
			bootVolume = existingVolumes[0];

			// Check if the volume has been configured
			if (bootVolume.metadata && bootVolume.metadata.status === 'configured') {
				bootVolumeIsConfigured = true;
				logger.success(`Found existing configured boot volume: ${bootVolume.name} (${bootVolume.id})`);
			} else {
				logger.info(`Found existing boot volume but it's not configured yet: ${bootVolume.name} (${bootVolume.id})`);
			}
		}

		if (!bootVolume) {
			// Create boot volume if it doesn't exist
			logger.info('Creating boot volume for TrueNAS Scale');
			bootVolume = await openstackController.createVolume({
				name: `${config.openstack.vms.storage.name}-boot`,
				size: 20,
				description: 'Boot volume for TrueNAS Scale',
			});
			logger.success(`Created boot volume: ${bootVolume.name} (${bootVolume.id})`);
		}

		// Check for existing storage volume
		let storageVolume = null;
		const existingStorageVolumes = await openstackController.getVolumes({
			name: `${config.openstack.vms.storage.name}-data`,
		});

		if (existingStorageVolumes && existingStorageVolumes.length > 0) {
			storageVolume = existingStorageVolumes[0];
			logger.info(`Found existing storage volume: ${storageVolume.name} (${storageVolume.id})`);
		} else {
			// Create storage volume if it doesn't exist
			logger.info('Creating storage volume for TrueNAS Scale');
			storageVolume = await openstackController.createVolume({
				name: `${config.openstack.vms.storage.name}-data`,
				size: 100,
				description: 'Data storage volume for TrueNAS Scale',
			});
			logger.success(`Created storage volume: ${storageVolume.name} (${storageVolume.id})`);
		}

		// Verify ISO image exists
		logger.info('Verifying TrueNAS Scale ISO image');
		const imagesResponse = await openstackController._client.Compute.imagesGet();
		const images = imagesResponse.data.images;
		const isoImage = images.find((img) => img.name === 'TrueNas Scale 25.04.0' || img.name.includes('TrueNAS Scale'));

		if (!isoImage) {
			throw new Error('TrueNAS Scale ISO image not found. Please upload it first.');
		}
		logger.success(`Found TrueNAS Scale ISO image: ${isoImage.name} (${isoImage.id})`);

		if (!bootVolumeIsConfigured) {
			// Wait for volumes to be available
			logger.info('Waiting for volumes to be available');
			await openstackController.waitForVolumeStatus(bootVolume.id, 'available');
			await openstackController.waitForVolumeStatus(storageVolume.id, 'available');

			// Create initialization VM to install TrueNAS Scale
			logger.info('Creating initialization VM for TrueNAS Scale installation');
			const initServerData = {
				name: `${config.openstack.vms.storage.name}-init`,
				flavor: 'a1-ram2-disk20-perf1', // With local disk for installation
				image: isoImage.name,
				ip,
				subnet: config.openstack.vms.storage.subnet,
				security_groups: config.openstack.vms.storage.security_groups,
				key_name: config.openstack.vms.storage.key_name,
				role: 'storage-init',
			};

			// Create the initialization VM
			const initServer = await openstackController.createVM(initServerData, resources);
			logger.success(`Created TrueNAS Scale initialization VM: ${initServer.name} (${initServer.id})`);

			// Wait for the server to be active
			await openstackController.waitForServerStatus(initServer.id, 'ACTIVE');

			// Attach volumes to the server
			await openstackController.attachVolumeToServer(bootVolume.id, initServer.id, '/dev/sda');
			await openstackController.attachVolumeToServer(storageVolume.id, initServer.id, '/dev/sdb');
			logger.success(`Attached volumes to initialization server: ${initServer.name}`);

			// Prompt user to install TrueNAS Scale
			logger.info('Please access the TrueNAS Scale installer and install it to the boot volume (sda).');
			logger.info(`Make sure to complete the initial setup and create an admin account.`);
			logger.info(`The VM will be accessible at IP: ${ip}`);

			// Wait for user confirmation that installation is complete
			await logger.promptUser('TrueNAS Scale installation completed. Press y to continue when TrueNAS is installed');

			// Update boot volume metadata to mark as configured
			await openstackController.updateVolume(bootVolume.id, {
				metadata: {
					status: 'configured',
					bootable: 'true',
				},
			});

			// Delete the initialization VM
			await openstackController.deleteVM(initServer.id);
			await openstackController.waitForServerStatus(initServer.id, 'ABSENT');
			logger.success(`Deleted TrueNAS Scale initialization VM: ${initServer.name} (${initServer.id})`);
		}

		// Make the boot volume bootable if it's not already
		try {
			const volumeServiceEndpoint = openstackController.getVolumeServiceEndpoint();
			const authClient = openstackController.getAuthenticatedAxios();

			logger.info(`Making boot volume ${bootVolume.id} bootable...`);

			await authClient.post(`volume/v3/volumes/${bootVolume.id}/action`, {
				'os-set_bootable': {
					bootable: true,
				},
			});

			logger.success(`Made boot volume ${bootVolume.id} bootable`);
		} catch (error) {
			logger.warn(`Error making volume bootable: ${error.message}`);
			// Continue anyway, as it might already be bootable
		}

		// Get the network port first (reuse existing port if present)
		logger.info('Setting up network port');
		let portId = null;
		try {
			logger.info(`Looking for existing port with IP: ${ip}`);
			const portsResponse = await openstackController._client.Network.portsGet();
			const ports = portsResponse.data.ports;
			const existingPort = ports.find((port) => {
				return port.fixed_ips.some((fixedIp) => fixedIp.ip_address === ip);
			});

			if (existingPort) {
				logger.info(`Found existing port with IP ${ip}, updating security groups`);
				portId = existingPort.id;

				// Update the port with the correct security groups
				const securityGroupIds = [];
				for (const sgName of config.openstack.vms.storage.security_groups) {
					const sg = resources.securityGroups.find((g) => g.name === sgName);
					if (sg) {
						securityGroupIds.push(sg.id);
					}
				}

				await openstackController._client.Network.portsPortIdPut(portId, {
					port: {
						security_groups: securityGroupIds,
					},
				});
			} else {
				logger.info(`Creating new port with fixed IP: ${ip}`);
				// Create the port with a fixed IP
				const subnet = resources.subnets.find((s) => s.name === config.openstack.vms.storage.subnet);
				if (!subnet) {
					throw new Error(`Subnet ${config.openstack.vms.storage.subnet} not found`);
				}

				const securityGroupIds = [];
				for (const sgName of config.openstack.vms.storage.security_groups) {
					const sg = resources.securityGroups.find((g) => g.name === sgName);
					if (sg) {
						securityGroupIds.push(sg.id);
					}
				}

				const portResponse = await openstackController._client.Network.portsPost({
					port: {
						network_id: resources.network.id,
						fixed_ips: [
							{
								subnet_id: subnet.id,
								ip_address: ip,
							},
						],
						security_groups: securityGroupIds,
					},
				});

				portId = portResponse.data.port.id;
				logger.info(`Created port with ID: ${portId} and IP: ${ip}`);
			}
		} catch (error) {
			logger.error(`Error handling port: ${error.message}`);
			throw error;
		}

		// Get flavor ID
		const flavorName = 'a1-ram2-disk0';
		const flavorsResponse = await openstackController._client.Compute.flavorsGet();
		const flavors = flavorsResponse.data.flavors;
		const flavor = flavors.find((f) => f.name === flavorName);
		if (!flavor) {
			throw new Error(`Flavor ${flavorName} not found`);
		}

		// Create server booting directly from volume
		logger.info('Creating TrueNAS Scale VM booting from volume');
		const serverData = {
			server: {
				name: config.openstack.vms.storage.name,
				flavorRef: flavor.id,
				networks: [{ port: portId }],
				key_name: config.openstack.vms.storage.key_name,
				block_device_mapping_v2: [
					{
						uuid: bootVolume.id,
						source_type: 'volume',
						destination_type: 'volume',
						boot_index: 0,
						delete_on_termination: false,
					},
				],
				metadata: {
					role: 'storage',
				},
			},
		};

		// No user_data for the VM as we're using SSH initialization

		// Create the server using the Nova API directly
		const computeServiceEndpoint = openstackController.getComputeServiceEndpoint();
		const authClient = openstackController.getAuthenticatedAxios();

		const existingServerResponse = await authClient.get(`${computeServiceEndpoint}/servers`);
		const existingServerData = existingServerResponse.data.servers;
		const existingServer = existingServerData.find((s) => s.name === config.openstack.vms.storage.name);
		let serverId = null;
		if (existingServer) {
			logger.info(`Found existing server with name ${config.openstack.vms.storage.name}, reusing it`);
			serverId = existingServer.id;
		} else {
			const serverResponse = await authClient.post(`${computeServiceEndpoint}/servers`, serverData);
			serverId = serverResponse.data.server.id;

			logger.success(`Created TrueNAS Scale VM with ID: ${serverId}`);
		}

		// Wait for the server to be active
		await openstackController.waitForServerStatus(serverId, 'ACTIVE');

		// Get the full server details
		const finalServerResponse = await openstackController._client.Compute.serversIdGet(serverId);
		const finalServer = finalServerResponse.data.server;

		// Attach the data volume
		await openstackController.attachVolumeToServer(storageVolume.id, serverId, '/dev/sdb');
		logger.success(`Attached volumes to TrueNAS Scale VM: ${finalServer.name}`);

		logger.info('Go to the TrueNAS Scale web interface to configure the storage volume.');
		logger.info(`TrueNAS Scale VM is accessible at IP: ${ip}`);
		await logger.promptUser('Press y to continue after configuring the storage volume');

		logger.success('TrueNAS Scale VM setup completed successfully');
		return {
			vm: finalServer,
			bootVolume: bootVolume,
			storageVolume: storageVolume,
			ip: ip,
		};
	} catch (error) {
		console.error(error);
		logger.error(`Failed to create TrueNAS Scale VM: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
