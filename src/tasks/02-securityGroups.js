/**
 * Task to create OpenStack security groups
 */
const openstackController = require('../controllers/openstack');
const logger = require('../utils/logger');

/**
 * Main task function
 * @param {Object} config - Configuration object
 * @returns {Promise<Array>} - Created security groups
 */
const run = async (config) => {
	try {
		logger.start('Creating OpenStack security groups');

		await openstackController.authenticate(config.openstack.auth);

		const securityGroups = [];

		logger.info('First pass: Creating security groups without interdependent rules');
		for (const sgConfig of config.openstack.security_groups) {
			try {
				const firstPassConfig = {
					...sgConfig,
					rules: sgConfig.rules.filter((rule) => !rule.remote_group),
				};

				const securityGroup = await openstackController.createSecurityGroup(firstPassConfig);
				securityGroups.push(securityGroup);
				logger.success(`Security group created: ${securityGroup.name} (${securityGroup.id})`);
			} catch (error) {
				logger.error(`Failed to create security group ${sgConfig.name}: ${error.message}`);
			}
		}

		logger.info('Second pass: Adding rules with security group references');
		for (const sgConfig of config.openstack.security_groups) {
			try {
				const securityGroupsResponse = await openstackController._client.Network.securityGroupsGet();
				const securityGroup = securityGroupsResponse.data.security_groups.find((sg) => sg.name === sgConfig.name);

				if (securityGroup) {
					const groupRules = sgConfig.rules.filter((rule) => rule.remote_group);

					for (const rule of groupRules) {
						try {
							await openstackController.addSecurityGroupRule(securityGroup.id, rule);
							logger.info(`Added reference rule to ${sgConfig.name} for remote group ${rule.remote_group}`);
						} catch (error) {
							logger.warn(`Could not add reference rule to ${sgConfig.name}: ${error.message}`);
						}
					}
				}
			} catch (error) {
				logger.error(`Failed to update rules for security group ${sgConfig.name}: ${error.message}`);
			}
		}

		logger.success(`Created and configured ${securityGroups.length} security groups`);
		return securityGroups;
	} catch (error) {
		logger.error(`Failed to create security groups: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
