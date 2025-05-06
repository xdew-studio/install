/**
 * Task to create OpenStack network resources
 */
const openstackController = require('../controllers/openstack');
const logger = require('../utils/logger');

/**
 * Main task function
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} - Created resources
 */
const run = async (config) => {
	try {
		logger.start('Creating OpenStack network resources');

		// Initialize and authenticate the OpenStack client
		await openstackController.authenticate(config.openstack.auth);

		// Create or use existing network
		const network = await openstackController.createNetwork(config.openstack.network);
		logger.success(`Network created: ${network.name} (${network.id})`);

		// Create or use existing subnets
		const subnets = [];
		for (const subnetConfig of config.openstack.network.subnets) {
			const subnet = await openstackController.createSubnet(subnetConfig, network.id);
			subnets.push(subnet);
			logger.success(`Subnet created: ${subnet.name} (${subnet.cidr})`);
		}

		// Create or use existing router and connect subnets
		const subnetIds = subnets.map((subnet) => subnet.id);
		const router = await openstackController.createRouter(
			{
				name: config.openstack.network.router_name,
			},
			subnetIds
		);
		logger.success(`Router created: ${router.name} (${router.id})`);

		return {
			network,
			subnets,
			router,
		};
	} catch (error) {
		logger.error(`Failed to create network resources: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
