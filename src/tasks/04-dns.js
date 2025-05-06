/**
 * Task to configure DNS via Cloudflare
 */
const cloudflareController = require('../controllers/cloudflare');
const openstackController = require('../controllers/openstack');
const logger = require('../utils/logger');

/**
 * Main task function
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} - DNS configuration results
 */
const run = async (config) => {
	try {
		logger.start('Configuring DNS via Cloudflare');

		await openstackController.authenticate(config.openstack.auth);

		const ipsToFetch = new Set();
		if (config.rancher && config.openstack.vms.rancher.floating_ip) {
			ipsToFetch.add(config.openstack.vms.rancher.floating_ip);
		}
		if (config.cloudflare && config.cloudflare.floating_ip) {
			ipsToFetch.add(config.cloudflare.floating_ip);
		}

		const floatingIps = {};
		for (const ipName of ipsToFetch) {
			const floatingIp = await openstackController.getFloatingIP(ipName);
			if (!floatingIp || !floatingIp.floating_ip_address) {
				throw new Error(`Floating IP not found: ${ipName}`);
			}
			floatingIps[ipName] = floatingIp.floating_ip_address;
			logger.info(`Floating IP ${ipName}: ${floatingIp.floating_ip_address}`);
		}

		if (config.rancher && config.rancher.domain && config.openstack.vms.rancher.floating_ip) {
			const rancherIp = floatingIps[config.openstack.vms.rancher.floating_ip];
			if (!rancherIp) {
				throw new Error(`Rancher IP not found: ${config.openstack.vms.rancher.floating_ip}`);
			}
			logger.info(`Configuring Rancher DNS: ${config.rancher.domain} -> ${rancherIp}`);
			await cloudflareController.configureServiceDns(config.cloudflare, [config.rancher.subdomain], rancherIp, false);
		}

		if (config.cloudflare.origin && config.cloudflare.floating_ip) {
			const originIp = floatingIps[config.cloudflare.floating_ip];
			if (!originIp) {
				throw new Error(`Origin IP not found: ${config.cloudflare.floating_ip}`);
			}
			logger.info(`Configuring origin DNS: ${config.cloudflare.origin}.${config.cloudflare.domain} -> ${originIp}`);
			await cloudflareController.configureServiceDns(config.cloudflare, [config.cloudflare.origin], originIp, true);
		}

		if (config.cloudflare.records && config.cloudflare.records.length > 0 && config.cloudflare.origin) {
			const originHostname = `${config.cloudflare.origin}.${config.cloudflare.domain}`;
			logger.info(`Configuring service DNS records as CNAMEs: ${config.cloudflare.records.join(', ')} -> ${originHostname}`);
			await cloudflareController.configureServiceCnames(config.cloudflare, config.cloudflare.records, originHostname, true);
		}

		logger.success('DNS configuration completed successfully');
		return {
			success: true,
			rancher_ip: config.rancher?.ip_name ? floatingIps[config.openstack.vms.rancher.floating_ip] : null,
			public_ip: config.cloudflare?.floating_ip ? floatingIps[config.cloudflare.floating_ip] : null,
		};
	} catch (error) {
		logger.error(`Failed to configure DNS: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
