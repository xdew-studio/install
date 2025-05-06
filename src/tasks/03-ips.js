/**
 * Task to create public floating IPs
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
		logger.start('Creating public floating IPs');

		await openstackController.authenticate(config.openstack.auth);

		const floatingIps = config.openstack.floating_ips;
		const createdIPs = [];

		for (const ipConfig of floatingIps) {
			const floatingIp = await openstackController.createFloatingIP(ipConfig);
			createdIPs.push(floatingIp);
			logger.success(`Created floating IP: ${floatingIp.floating_ip_address}`);
		}

		logger.success(`Created ${floatingIps.length} floating IPs`);
		return createdIPs;
	} catch (error) {
		logger.error(`Failed to create network resources: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
