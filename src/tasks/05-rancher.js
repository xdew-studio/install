/**
 * Task to create and configure the Rancher VM
 */
const openstackController = require('../controllers/openstack');
const logger = require('../utils/logger');

/**
 * Main task function
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} - Created VM and floating IP
 */
const run = async (config) => {
	try {
		logger.start('Creating Rancher VM and floating IP');

		await openstackController.authenticate(config.openstack.auth);

		const network = await openstackController.getNetwork(config.openstack.network.name);

		const securityGroups = [];
		for (const sgName of config.openstack.vms.rancher.security_groups) {
			const sgConfig = config.openstack.security_groups.find((sg) => sg.name === sgName);
			if (!sgConfig) {
				throw new Error(`Security group configuration for ${sgName} not found`);
			}
			const securityGroup = await openstackController.createSecurityGroup(sgConfig);
			securityGroups.push(securityGroup);
		}

		const subnetsResponse = await openstackController._client.Network.subnetsGet();
		const subnets = subnetsResponse.data.subnets;
		const subnet = subnets.find((s) => s.name === config.openstack.vms.rancher.subnet);
		if (!subnet) {
			throw new Error(`Subnet ${config.openstack.vms.rancher.subnet} not found`);
		}

		const resources = {
			network,
			securityGroups,
			subnets: [subnet],
		};

		const cidrBase = subnet.cidr.split('/')[0].split('.');
		cidrBase[3] = '10';
		const ip = cidrBase.join('.');

		let userData = null;
		if (config.openstack.vms.rancher.user_data) {
			if (config.openstack.vms.rancher.user_data.startsWith('http')) {
				const response = await fetch(config.openstack.vms.rancher.user_data);
				userData = await response.text();
				userData = userData.replace('__RANCHER_DOMAIN__', config.rancher.domain);
				userData = userData.replace('__YOUR_EMAIL__', config.rancher.email);
				userData = userData.replace('__ADMIN_PASSWORD__', config.rancher.admin_password);
				userData = userData.replace('__CLI_PASSWORD__', config.rancher.cli_password);
			} else {
				userData = config.openstack.vms.rancher.user_data;
			}
			userData = Buffer.from(userData).toString('base64');
		}

		const vm = {
			...config.openstack.vms.rancher,
			user_data: userData,
			ip: ip,
			role: 'rancher',
		};

		const rancherVM = await openstackController.createVM(vm, resources);
		logger.success(`Created Rancher VM: ${rancherVM.name} (${rancherVM.id})`);

		const floatingIp = await openstackController.getFloatingIP(config.openstack.vms.rancher.floating_ip);
		await openstackController.associateFloatingIP(floatingIp.id, config.openstack.network.name, rancherVM.id);
		logger.success(`Associated floating IP ${floatingIp.floating_ip_address} with Rancher VM`);

		await openstackController.waitForServerStatus(rancherVM.id, 'ACTIVE');
		logger.success('Rancher VM setup completed successfully');

		return {
			vm: rancherVM,
			floatingIp: floatingIp,
		};
	} catch (error) {
		logger.error(`Failed to create Rancher VM: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
