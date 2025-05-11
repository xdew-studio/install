/**
 * Task to create a Kubernetes cluster in Rancher and deploy master/worker nodes
 */
const rancherController = require('../controllers/rancher');
const openstackController = require('../controllers/openstack');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');

/**
 * Create a VM with proper hostname, IP and user data configuration
 * @param {Object} config - Full configuration object
 * @param {Object} vmConfig - VM configuration
 * @param {Object} resources - OpenStack resources
 * @param {Object} replacements - Values to replace in the configuration
 * @returns {Promise<Object>} - Created VM
 */
async function createNode(config, vmConfig, resources, replacements = {}) {
	try {
		const subnet = resources.subnets.find((s) => s.name === vmConfig.subnet);
		if (!subnet) {
			throw new Error(`Subnet ${vmConfig.subnet} not found`);
		}

		const cidrBase = subnet.cidr.split('/')[0].split('.');
		cidrBase[3] = String(replacements.ipOffset || 10);
		const ip = cidrBase.join('.');

		let vmName = vmConfig.name;
		if (vmName.includes('{{ x }}') && replacements.index !== undefined) {
			vmName = vmName.replace('{{ x }}', replacements.index);
		}

		let userData = null;
		if (vmConfig.user_data) {
			if (vmConfig.user_data.startsWith('http')) {
				const response = await fetch(vmConfig.user_data);
				userData = await response.text();

				if (replacements.nodeType === 'master') {
					userData = userData.replace(/__RANCHER_URL__/g, `https://${config.rancher.domain}`);
					userData = userData.replace(/__RANCHER_AGENT_TOKEN__/g, config.kubernetes.token || '');
				} else if (replacements.nodeType === 'worker') {
					userData = userData.replace(/__RANCHER_URL__/g, `https://${config.rancher.domain}`);
					userData = userData.replace(/__RANCHER_AGENT_TOKEN__/g, config.kubernetes.token || '');
				}
			} else {
				userData = vmConfig.user_data;
			}

			userData = Buffer.from(userData).toString('base64');
		}

		const vm = {
			...vmConfig,
			name: vmName,
			user_data: userData,
			ip: ip,
		};

		if (replacements.nodeType) {
			vm.role = replacements.nodeType;
		}

		logger.info(`Creating ${replacements.nodeType || 'node'} VM: ${vmName}`);
		const createdVM = await openstackController.createVM(vm, resources);
		logger.success(`Created VM: ${createdVM.name} (${createdVM.id})`);

		await openstackController.waitForServerStatus(createdVM.id, 'ACTIVE');

		return createdVM;
	} catch (error) {
		logger.error(`Failed to create node: ${error.message}`);
		throw error;
	}
}

/**
 * Create multiple nodes of the same type
 * @param {Object} config - Full configuration object
 * @param {String} nodeType - Type of node ('master' or 'worker')
 * @param {Object} resources - OpenStack resources
 * @returns {Promise<Array>} - Created VMs
 */
async function createNodes(config, nodeType, resources) {
	const nodeConfig = config.openstack.vms[nodeType];
	const count = nodeConfig.count || 1;
	const nodes = [];

	logger.info(`Creating ${count} ${nodeType} nodes`);

	for (let i = 0; i < count; i++) {
		const replacements = {
			nodeType: nodeType,
			index: i + 1,
			ipOffset: 10 + i,
		};

		const vm = await createNode(config, nodeConfig, resources, replacements);
		nodes.push(vm);

		if (i < count - 1) {
			await new Promise((resolve) => setTimeout(resolve, 5000));
		}
	}

	return nodes;
}

/**
 * Main task function
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} - Created Kubernetes cluster, nodes, and configuration
 */
const run = async (config) => {
	try {
		logger.start('Creating Kubernetes cluster and deploying nodes');

		logger.info('Waiting for Rancher to be accessible...');
		await rancherController.waitForRancherAvailability(config.rancher.domain);

		logger.info('Authenticating with Rancher');
		await rancherController.authenticate({
			domain: config.rancher.domain,
			username: config.rancher.username || 'cli',
			password: config.rancher.password || config.rancher.cli_password,
		});

		const clusterConfig = {
			name: config.general.name,
			version: config.kubernetes.version,
			machinePools: config.kubernetes.machinePools || [],
		};

		const cluster = await rancherController.createCluster(clusterConfig);
		logger.success(`Created Kubernetes cluster: ${cluster.metadata.name}`);

		// Wait a moment for the cluster to be properly initialized in Rancher
		logger.info('Waiting for cluster to initialize in Rancher...');
		await new Promise((resolve) => setTimeout(resolve, 10000));

		logger.info('Generating registration token for cluster nodes');
		// Pass both cluster ID and optional name to help the controller find the right cluster
		const registrationToken = await rancherController.getRegistrationToken(cluster.metadata.name, cluster.status?.clusterName);

		// Store the token in the config for node creation
		config.kubernetes.token = registrationToken.token;

		const dataDir = path.join(process.cwd(), 'data');
		await fs.mkdir(dataDir, { recursive: true });

		logger.info('Preparing OpenStack resources for node deployment');
		await openstackController.authenticate(config.openstack.auth);

		const network = await openstackController.getNetwork(config.openstack.network.name);
		const subnetsResponse = await openstackController._client.Network.subnetsGet();
		const subnets = subnetsResponse.data.subnets;

		const securityGroups = {};
		const nodeTypes = ['master', 'worker'];

		for (const nodeType of nodeTypes) {
			securityGroups[nodeType] = [];
			const sgNames = config.openstack.vms[nodeType].security_groups;

			for (const sgName of sgNames) {
				const sgConfig = config.openstack.security_groups.find((sg) => sg.name === sgName);
				if (!sgConfig) {
					throw new Error(`Security group configuration for ${sgName} not found`);
				}
				const securityGroup = await openstackController.createSecurityGroup(sgConfig);
				securityGroups[nodeType].push(securityGroup);
			}
		}

		const resources = {
			network,
			subnets,
			securityGroups: [...securityGroups.master, ...securityGroups.worker],
		};

		logger.info('Deploying Kubernetes master nodes');
		const masterNodes = await createNodes(config, 'master', resources);

		logger.info('Deploying Kubernetes worker nodes');
		const workerNodes = await createNodes(config, 'worker', resources);

		logger.info('Waiting for Kubernetes cluster to be ready...');
		const readyCluster = await rancherController.waitForClusterReady(cluster.id);

		if (config.kubernetes.projects && config.kubernetes.projects.length > 0) {
			logger.info('Creating projects and namespaces');

			for (const projectConfig of config.kubernetes.projects) {
				const project = await rancherController.createProject(cluster.id, projectConfig);
				logger.success(`Created project: ${project.name}`);

				if (projectConfig.namespaces && projectConfig.namespaces.length > 0) {
					for (const namespaceConfig of projectConfig.namespaces) {
						namespaceConfig.clusterId = cluster.id;

						const namespace = await rancherController.createNamespace(project.id, namespaceConfig);
						logger.success(`Created namespace: ${namespace.name} in project ${project.name}`);
					}
				}
			}
		}

		logger.info('Generating kubeconfig for the cluster');
		const kubeconfig = await rancherController.getKubeConfig(cluster.id);

		const kubeconfigPath = path.join(dataDir, `${cluster.metadata.name}-kubeconfig.yaml`);
		await fs.writeFile(kubeconfigPath, kubeconfig, 'utf8');
		logger.success(`Kubeconfig written to ${kubeconfigPath}`);

		const output = {
			cluster: readyCluster,
			registrationToken,
			masters: masterNodes,
			workers: workerNodes,
			nodeCounts: {
				masters: masterNodes.length,
				workers: workerNodes.length,
			},
			kubeconfigPath,
		};

		logger.success('Kubernetes cluster and nodes deployment completed successfully');
		return output;
	} catch (error) {
		logger.error(`Failed to create Kubernetes cluster and nodes: ${error.message}`);
		throw error;
	}
};

module.exports = {
	run,
};
