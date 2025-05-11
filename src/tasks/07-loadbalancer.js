/**
 * Task to create OpenStack load balancer resources
 */
const openstackController = require('../controllers/openstack');
const logger = require('../utils/logger');

/**
 * Main task function for creating a load balancer
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} - Created load balancer resource
 */
const run = async (config) => {
	try {
		logger.start('Creating OpenStack load balancer');

		await openstackController.authenticate(config.openstack.auth);

		const network = await openstackController.getNetwork(config.openstack.network.name);
		logger.info(`Using network: ${network.name} (${network.id})`);

		const subnetResponse = await openstackController._client.Network.subnetsGet();
		const subnets = subnetResponse.data.subnets;
		const lbSubnet = subnets.find((s) => s.name === config.openstack.loadbalancer.subnet);

		if (!lbSubnet) {
			throw new Error(`Required subnet ${config.openstack.loadbalancer.subnet} not found`);
		}
		logger.info(`Using subnet: ${lbSubnet.name} (${lbSubnet.id})`);

		let floatingIp = null;
		if (config.openstack.loadbalancer.floating_ip) {
			floatingIp = await openstackController.getFloatingIP(config.openstack.loadbalancer.floating_ip);
			logger.info(`Using floating IP: ${floatingIp.floating_ip_address} (${floatingIp.id})`);
		}

		const resources = {
			network,
			subnets: [lbSubnet],
			floatingIps: floatingIp ? [{ id: floatingIp.id, name: config.openstack.loadbalancer.floating_ip }] : [],
		};

		const loadBalancer = await openstackController.createLoadBalancer(config.openstack.loadbalancer, resources);
		logger.success(`Load balancer created: ${loadBalancer.name} (${loadBalancer.id})`);

		await openstackController.waitForLoadBalancerStatus(loadBalancer.id, 'ACTIVE');

		const httpListener = await openstackController.createLoadBalancerListener({
			name: `${loadBalancer.name}-http-listener`,
			protocol: 'HTTP',
			protocol_port: 80,
			loadbalancer_id: loadBalancer.id,
		});

		const httpsListener = await openstackController.createLoadBalancerListener({
			name: `${loadBalancer.name}-https-listener`,
			protocol: 'HTTPS',
			protocol_port: 443,
			loadbalancer_id: loadBalancer.id,
		});

		const httpPool = await openstackController.createLoadBalancerPool({
			name: `${loadBalancer.name}-http-pool`,
			protocol: 'HTTP',
			lb_algorithm: 'ROUND_ROBIN',
			listener_id: httpListener.id,
			loadbalancer_id: loadBalancer.id,
		});

		const httpsPool = await openstackController.createLoadBalancerPool({
			name: `${loadBalancer.name}-https-pool`,
			protocol: 'HTTPS',
			lb_algorithm: 'ROUND_ROBIN',
			listener_id: httpsListener.id,
			loadbalancer_id: loadBalancer.id,
		});

		const httpMonitor = await openstackController.createHealthMonitor({
			name: `${loadBalancer.name}-http-monitor`,
			pool_id: httpPool.id,
			type: 'HTTP',
			delay: 5,
			timeout: 5,
			max_retries: 3,
			max_retries_down: 3,
			http_method: 'GET',
			url_path: '/',
			expected_codes: '200,301,302,404',
			loadbalancer_id: loadBalancer.id,
		});

		const httpsMonitor = await openstackController.createHealthMonitor({
			name: `${loadBalancer.name}-https-monitor`,
			pool_id: httpsPool.id,
			type: 'HTTP',
			delay: 5,
			timeout: 5,
			max_retries: 3,
			max_retries_down: 3,
			http_method: 'GET',
			url_path: '/',
			expected_codes: '200,301,302,404',
			loadbalancer_id: loadBalancer.id,
		});

		const baseClusterName = config.general.name;
		const serversResponse = await openstackController._client.Compute.serversGet();

		const workers = [];
		for (const server of serversResponse.data.servers) {
			const worker = await openstackController.getVMById(server.id);
			if (worker.metadata && worker.metadata.role === 'worker') {
				workers.push(worker);
			}
		}

		if (workers.length > 0) {
			logger.info(`Found ${workers.length} worker nodes to add to load balancer pools`);

			const workerSubnets = workers.map((worker) => worker.metadata.subnet);
			const allSame = workerSubnets.length > 0 && workerSubnets.every((subnet) => subnet === workerSubnets[0]);

			if (!allSame) {
				logger.warn('Worker nodes are not in the same subnet, cannot add them to load balancer pools');
				return;
			}
			const workerSubnet = workerSubnets[0];

			if (!workerSubnet) {
				logger.warn(`Worker subnet not found, can't add members to pools`);
			} else {
				for (const [index, worker] of workers.entries()) {
					const networkName = config.openstack.network.name;

					if (!worker.addresses || !worker.addresses[networkName] || worker.addresses[networkName].length === 0) {
						logger.warn(`Could not find IP address for worker ${worker.name}`);
						continue;
					}

					const workerIp = worker.addresses[networkName][0].addr;

					await openstackController.addPoolMember({
						name: `${baseClusterName}-worker-${index + 1}`,
						address: workerIp,
						protocol_port: 80,
						subnet_id: workerSubnet.id,
						pool_id: httpPool.id,
						loadbalancer_id: loadBalancer.id,
					});

					await openstackController.addPoolMember({
						name: `${baseClusterName}-worker-${index + 1}`,
						address: workerIp,
						protocol_port: 443,
						subnet_id: workerSubnet.id,
						pool_id: httpsPool.id,
						monitor_port: 80,
						loadbalancer_id: loadBalancer.id,
					});
				}
			}
		} else {
			logger.warn('No worker nodes found to add to load balancer pools');
		}

		logger.success('Load balancer setup completed successfully');

		return {
			loadBalancer,
			httpListener,
			httpsListener,
			httpPool,
			httpsPool,
			httpMonitor,
			httpsMonitor,
		};
	} catch (error) {
		logger.error(`Failed to create load balancer: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
