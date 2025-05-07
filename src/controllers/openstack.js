/**
 * OpenStack controller for managing OpenStack resources using @netzreich/openstack-clients
 */

const OpenStack = require('@netzreich/openstack-clients').default;
const { Identity } = require('@netzreich/openstack-clients');
const logger = require('../utils/logger');
const axios = require('axios');

class OpenStackController {
	constructor() {
		this._client = null;
		this._authenticatedAxios = null;
	}

	/**
	 * Initialize OpenStack client with authentication details
	 * @param {Object} authConfig - OpenStack authentication configuration
	 * @returns {Promise<OpenStackController>} This instance for chaining
	 */
	async authenticate(authConfig) {
		try {
			logger.info('Initializing OpenStack client');

			const config = new Identity.Configuration({
				basePath: authConfig.auth_url,
				baseOptions: {
					headers: {
						'Content-Type': 'application/json',
					},
				},
			});

			let auth = {
				auth: {
					identity: {
						methods: ['application_credential'],
						application_credential: {
							id: authConfig.application_credential_id,
							secret: authConfig.application_credential_secret,
						},
					},
					region: authConfig.region_name,
				},
			};

			this._client = new OpenStack(config, auth, logger);

			await this._client.authenticate(undefined, true, 10, 15000);
			logger.success('Successfully authenticated with OpenStack');

			return this;
		} catch (error) {
			logger.error(`OpenStack authentication failed: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Gets an authenticated Axios client for OpenStack API requests
	 * @returns {Object} - Authenticated Axios client
	 */
	getAuthenticatedAxios() {
		if (!this._client || this._client.isTokenExpired()) {
			throw new Error('Authentication token expired. Please authenticate first.');
		}

		if (this._authenticatedAxios) {
			return this._authenticatedAxios;
		}

		const networkService = this._client._catalog.find((entry) => entry.type === 'network');
		if (!networkService || !networkService.endpoints) {
			throw new Error('Network service not found in catalog');
		}

		const endpoint = networkService.endpoints.find((ep) => ep.interface === 'public');
		if (!endpoint || !endpoint.url) {
			throw new Error('Public endpoint not found for network service');
		}

		const url = new URL(endpoint.url);
		const basePath = `${url.protocol}//${url.host}`;

		this._authenticatedAxios = axios.create({
			baseURL: basePath,
			headers: {
				'Content-Type': 'application/json',
				'X-Auth-Token': this._client._token,
			},
		});

		return this._authenticatedAxios;
	}

	/**
	 * Get network by name
	 * @param {String} networkName - Name of the network
	 * @returns {Promise<Object>} Network object
	 */
	async getNetwork(networkName) {
		try {
			const networksResponse = await this._client.Network.networksGet();
			const networks = networksResponse.data.networks;
			const network = networks.find((n) => n.name === networkName);

			if (!network) {
				throw new Error(`Network ${networkName} not found`);
			}

			return network;
		} catch (error) {
			logger.error(`Failed to get network: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create a network if it doesn't exist
	 * @param {Object} networkConfig - Network configuration
	 * @returns {Promise<Object>} Created or existing network
	 */
	async createNetwork(networkConfig) {
		try {
			logger.info(`Creating network: ${networkConfig.name}`);

			const networksResponse = await this._client.Network.networksGet();
			const networks = networksResponse.data.networks;
			const existingNetwork = networks.find((n) => n.name === networkConfig.name);

			if (existingNetwork) {
				logger.info(`Network ${networkConfig.name} already exists, using existing network`);
				return existingNetwork;
			}

			const network = await this._client.Network.networksPost({
				network: {
					name: networkConfig.name,
					admin_state_up: true,
				},
			});

			logger.success(`Network ${networkConfig.name} created successfully`);
			return network.data.network;
		} catch (error) {
			logger.error(`Failed to create network: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create a subnet if it doesn't exist
	 * @param {Object} subnetConfig - Subnet configuration
	 * @param {String} networkId - ID of the network
	 * @returns {Promise<Object>} Created or existing subnet
	 */
	async createSubnet(subnetConfig, networkId) {
		try {
			logger.info(`Creating subnet: ${subnetConfig.name}`);

			const subnetsResponse = await this._client.Network.subnetsGet();
			const subnets = subnetsResponse.data.subnets;
			const existingSubnet = subnets.find((s) => s.name === subnetConfig.name);

			if (existingSubnet) {
				logger.info(`Subnet ${subnetConfig.name} already exists, using existing subnet`);
				return existingSubnet;
			}

			const subnet = await this._client.Network.subnetsPost({
				subnet: {
					name: subnetConfig.name,
					network_id: networkId,
					ip_version: 4,
					cidr: subnetConfig.cidr,
					enable_dhcp: true,
				},
			});

			logger.success(`Subnet ${subnetConfig.name} created successfully`);
			return subnet.data.subnet;
		} catch (error) {
			logger.error(`Failed to create subnet: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create a router if it doesn't exist
	 * @param {Object} routerConfig - Router configuration
	 * @param {Array} subnetIds - IDs of subnets to connect
	 * @returns {Promise<Object>} Created or existing router
	 */
	async createRouter(routerConfig, subnetIds) {
		try {
			logger.info(`Creating router: ${routerConfig.name}`);
			const routersResponse = await this._client.Network.routersGet();
			const routers = routersResponse.data.routers;
			const existingRouter = routers.find((r) => r.name === routerConfig.name);
			let router;

			if (existingRouter) {
				logger.info(`Router ${routerConfig.name} already exists, using existing router`);
				router = existingRouter;
			} else {
				const externalNetworkId = await this.getExternalNetworkId();
				const routerResponse = await this._client.Network.routersPost({
					router: {
						...routerConfig,
						admin_state_up: true,
						external_gateway_info: {
							network_id: externalNetworkId,
							enable_snat: true,
						},
					},
				});
				router = routerResponse.data.router;
				logger.success(`Router ${routerConfig.name} created successfully`);
			}

			for (const subnetId of subnetIds) {
				try {
					await this._client.Network.routersIdAddRouterInterfacePut(router.id, {
						subnet_id: subnetId,
					});
					logger.info(`Connected subnet ${subnetId} to router ${routerConfig.name}`);
				} catch (error) {
					const message = error.response?.data?.NeutronError?.message;
					if (message && message.includes('Router already has')) {
						logger.info(`Subnet ${subnetId} is already connected to router ${routerConfig.name}`);
					} else {
						throw new Error(`Failed to connect subnet ${subnetId} to router ${routerConfig.name}: ${error.message}`);
					}
				}
			}

			return router;
		} catch (error) {
			logger.error(`Failed to create router: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get the ID of the external network
	 * @returns {Promise<String>} ID of the external network
	 */
	async getExternalNetworkId() {
		try {
			const networksResponse = await this._client.Network.networksGet();
			const networks = networksResponse.data.networks;
			const externalNetwork = networks.find((n) => n.name === 'ext-floating1');

			if (!externalNetwork) {
				throw new Error('No external network found');
			}

			return externalNetwork.id;
		} catch (error) {
			logger.error(`Failed to get external network: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create a security group if it doesn't exist or update an existing one
	 * @param {Object} sgConfig - Security group configuration
	 * @returns {Promise<Object>} Created or existing security group
	 */
	async createSecurityGroup(sgConfig) {
		try {
			logger.info(`Creating security group: ${sgConfig.name}`);

			const securityGroupsResponse = await this._client.Network.securityGroupsGet();
			const securityGroups = securityGroupsResponse.data.security_groups;
			const existingGroup = securityGroups.find((sg) => sg.name === sgConfig.name);

			if (existingGroup) {
				logger.info(`Security group ${sgConfig.name} already exists, updating rules`);
				await this.addMissingRules(existingGroup, sgConfig.rules);
				return existingGroup;
			}

			const securityGroupResponse = await this._client.Network.securityGroupsPost({
				security_group: {
					name: sgConfig.name,
					description: sgConfig.description || `Security group for ${sgConfig.name}`,
				},
			});
			const securityGroup = securityGroupResponse.data.security_group;

			for (const rule of sgConfig.rules) {
				try {
					await this.addSecurityGroupRule(securityGroup.id, rule);
				} catch (error) {
					logger.warn(`Could not add rule to ${sgConfig.name}: ${error.message}`);
				}
			}

			logger.success(`Security group ${sgConfig.name} created successfully`);
			return securityGroup;
		} catch (error) {
			logger.error(`Failed to create security group: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Add missing rules to an existing security group
	 * @param {Object} securityGroup - Existing security group
	 * @param {Array} rules - Rules to add
	 */
	async addMissingRules(securityGroup, rules) {
		try {
			const existingRules = securityGroup.security_group_rules || [];

			for (const rule of rules) {
				const ruleExists = existingRules.some((r) => r.direction === rule.direction && r.protocol === rule.protocol && r.port_range_min === rule.port_range_min && r.port_range_max === rule.port_range_max);

				if (!ruleExists) {
					try {
						await this.addSecurityGroupRule(securityGroup.id, rule);
					} catch (error) {
						console.error(`Could not add rule to ${securityGroup.name}: ${error.message}`);
					}
				}
			}
		} catch (error) {
			logger.error(`Failed to update security group rules: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Add a single rule to a security group with better error handling
	 * @param {String} groupId - ID of the security group
	 * @param {Object} rule - Rule to add
	 */
	async addSecurityGroupRule(groupId, rule) {
		try {
			const ruleConfig = {
				direction: rule.direction,
				security_group_id: groupId,
				protocol: rule.protocol,
				port_range_min: rule.port_range_min,
				port_range_max: rule.port_range_max,
				ethertype: 'IPv4',
			};

			if (rule.remote_ip_prefix) {
				ruleConfig.remote_ip_prefix = rule.remote_ip_prefix;
			} else if (rule.remote_group) {
				const securityGroupsResponse = await this._client.Network.securityGroupsGet();
				const groups = securityGroupsResponse.data.security_groups;
				const remoteGroup = groups.find((g) => g.name === rule.remote_group);

				if (!remoteGroup) {
					throw new Error(`Referenced security group ${rule.remote_group} not found`);
				}

				ruleConfig.remote_group_id = remoteGroup.id;
			}

			await this._client.Network.securityGroupRulesPost({
				security_group_rule: ruleConfig,
			});

			logger.info(`Added rule to security group ${groupId}: ${rule.protocol} ${rule.port_range_min}-${rule.port_range_max}`);
		} catch (error) {
			if (error.response && error.response.status === 409) {
				logger.info(`Rule already exists in security group ${groupId}`);
				return;
			}

			if (error.response?.data?.NeutronError?.message?.includes('Security group rule already exists')) {
				logger.info(`Rule already exists in security group ${groupId}`);
				return;
			}

			throw error;
		}
	}

	/**
	 * Create a VM instance with a specific IP address
	 * @param {Object} vmConfig - VM configuration
	 * @param {Object} resources - Resource mappings (networks, security groups, etc.)
	 * @returns {Promise<Object>} Created VM instance
	 */
	async createVM(vmConfig, resources) {
		try {
			logger.info(`Creating VM: ${vmConfig.name}`);
			const serversResponse = await this._client.Compute.serversGet();
			const servers = serversResponse.data.servers;
			const existingServer = servers.find((s) => s.name === vmConfig.name);
			if (existingServer) {
				logger.info(`VM ${vmConfig.name} already exists, using existing VM`);
				return existingServer;
			}

			const imagesResponse = await this._client.Compute.imagesGet();
			const images = imagesResponse.data.images;
			const image = images.find((i) => i.name === vmConfig.image);
			if (!image) {
				throw new Error(`Image ${vmConfig.image} not found`);
			}

			const flavorsResponse = await this._client.Compute.flavorsGet();
			const flavors = flavorsResponse.data.flavors;
			const flavor = flavors.find((f) => f.name === vmConfig.flavor);
			if (!flavor) {
				throw new Error(`Flavor ${vmConfig.flavor} not found`);
			}

			const subnet = resources.subnets.find((s) => s.name === vmConfig.subnet);
			if (!subnet) {
				throw new Error(`Subnet ${vmConfig.subnet} not found`);
			}

			const securityGroups = [];
			for (const sgName of vmConfig.security_groups) {
				const sg = resources.securityGroups.find((g) => g.name === sgName);
				if (!sg) {
					throw new Error(`Security group ${sgName} not found`);
				}
				securityGroups.push({ name: sg.name, id: sg.id });
			}

			let networkConfig;
			let existingPort = null;

			if (vmConfig.ip) {
				logger.info(`Checking for existing port with IP: ${vmConfig.ip}`);

				const existingPortsResponse = await this._client.Network.portsGet();

				const existingPorts = existingPortsResponse.data.ports.filter((port) => {
					return port.fixed_ips.some((fixedIp) => fixedIp.ip_address === vmConfig.ip);
				});

				if (existingPorts.length > 0) {
					existingPort = existingPorts[0];

					if (existingPort.status === 'ACTIVE') {
						throw new Error(`Port with IP ${vmConfig.ip} is already in use by another device`);
					} else {
						logger.info(`Found existing unused port with ID: ${existingPort.id} and IP: ${vmConfig.ip}`);

						await this._client.Network.portsPortIdPut(existingPort.id, {
							port: {
								security_groups: securityGroups.map((sg) => sg.id),
							},
						});

						networkConfig = [{ port: existingPort.id }];
					}
				} else {
					logger.info(`Creating new port with fixed IP: ${vmConfig.ip}`);
					const portResponse = await this._client.Network.portsPost({
						port: {
							network_id: resources.network.id,
							fixed_ips: [
								{
									subnet_id: subnet.id,
									ip_address: vmConfig.ip,
								},
							],
							security_groups: securityGroups.map((sg) => sg.id),
						},
					});

					const port = portResponse.data.port;
					logger.info(`Created port with ID: ${port.id} and IP: ${vmConfig.ip}`);
					networkConfig = [{ port: port.id }];
				}
			} else {
				networkConfig = [{ uuid: resources.network.id }];
			}

			const serverResponse = await this._client.Compute.serversPost({
				server: {
					name: vmConfig.name,
					imageRef: image.id,
					flavorRef: flavor.id,
					networks: networkConfig,
					security_groups: vmConfig.ip ? [] : securityGroups,
					user_data: vmConfig.user_data,
					key_name: vmConfig.key_name,
					metadata: {
						subnet: vmConfig.subnet,
						role: vmConfig.role || 'uncategorized',
					},
				},
			});

			const server = serverResponse.data.server;
			await this.waitForServerStatus(server.id, 'ACTIVE');

			if (!vmConfig.ip) {
				await this.configureVMNetworking(server.id, subnet.id);
			}

			logger.success(`VM ${vmConfig.name} created successfully`);
			const updatedServerResponse = await this._client.Compute.serversIdGet(server.id);
			return updatedServerResponse.data.server;
		} catch (error) {
			logger.error(`Failed to create VM: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Configure VM networking with the correct subnet and specific IP address
	 * @param {String} serverId - ID of the server
	 * @param {String} subnetId - ID of the subnet
	 * @param {String} ip - Specific IP address to assign (optional)
	 */
	async configureVMNetworking(serverId, subnetId, ip) {
		try {
			const portsResponse = await this._client.Network.portsGet({
				device_id: serverId,
			});
			const ports = portsResponse.data.ports;

			if (ports.length > 0) {
				if (ip) {
					logger.info(`Configuring VM network to use subnet ${subnetId} with fixed IP: ${ip}`);
					await this._client.Network.portsPutId({
						id: ports[0].id,
						port: {
							fixed_ips: [{ subnet_id: subnetId, ip_address: ip }],
						},
					});

					logger.info(`VM network configured with fixed IP: ${ip}`);
					return;
				}

				for (const port of ports) {
					const fixedIp = port.fixed_ips.find((fixedIp) => fixedIp.subnet_id === subnetId);
					if (fixedIp) {
						logger.info(`VM is already connected to the correct subnet with IP: ${fixedIp.ip_address}`);
						return;
					}
				}

				logger.info(`Configuring VM network to use subnet ${subnetId}`);
				await this._client.Network.portsPutId({
					id: ports[0].id,
					port: {
						fixed_ips: [{ subnet_id: subnetId }],
					},
				});
				logger.info(`VM network configured to use the correct subnet`);
			} else {
				logger.warn(`No ports found for server ${serverId}`);
			}
		} catch (error) {
			logger.error(`Failed to configure VM networking: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Wait for a server to reach a specific status
	 * @param {String} serverId - ID of the server
	 * @param {String} targetStatus - Status to wait for
	 * @param {Number} timeout - Timeout in seconds
	 */
	async waitForServerStatus(serverId, targetStatus, timeout = 300) {
		try {
			logger.waiting(`Waiting for server ${serverId} to reach status ${targetStatus}`);

			const startTime = Date.now();
			const endTime = startTime + timeout * 1000;

			while (Date.now() < endTime) {
				const serverResponse = await this._client.Compute.serversIdGet(serverId);
				const server = serverResponse.data.server;

				if (server.status === targetStatus) {
					logger.info(`Server ${serverId} reached status ${targetStatus}`);
					return server;
				}

				await new Promise((resolve) => setTimeout(resolve, 5000));

				const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
				logger.progress(`Server status: ${server.status}, waiting for ${targetStatus}`, Math.floor((elapsedSeconds / timeout) * 100));
			}

			throw new Error(`Timeout waiting for server to reach status ${targetStatus}`);
		} catch (error) {
			logger.error(`Error waiting for server status: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create a floating IP if it doesn't exist
	 * @param {Object} floatingIpConfig - Floating IP configuration
	 * @returns {Promise<Object>} Created or existing floating IP
	 */
	async createFloatingIP(floatingIpConfig) {
		try {
			logger.info(`Creating floating IP: ${floatingIpConfig.name}`);

			const authClient = this.getAuthenticatedAxios();
			const floatingIpsResponse = await authClient.get('network/v2.0/floatingips');
			const floatingIps = floatingIpsResponse.data.floatingips;

			const existingIp = floatingIps.find((ip) => {
				if (!ip.tags) return false;
				return ip.tags.includes(`name:${floatingIpConfig.name}`);
			});

			if (existingIp) {
				logger.info(`Floating IP ${floatingIpConfig.name} already exists, using existing IP: ${existingIp.floating_ip_address}`);
				return existingIp;
			}

			const networksResponse = await authClient.get('network/v2.0/networks');
			const networks = networksResponse.data.networks;
			const externalNetwork = networks.find((n) => n.name === 'ext-floating1');

			if (!externalNetwork) {
				throw new Error('No external network found');
			}

			const floatingIpResponse = await authClient.post('network/v2.0/floatingips', {
				floatingip: {
					floating_network_id: externalNetwork.id,
					description: floatingIpConfig.description || `Floating IP for ${floatingIpConfig.name}`,
				},
			});

			const floatingIp = floatingIpResponse.data.floatingip;

			this.addTagsToFloatingIP(floatingIp.id, [`name:${floatingIpConfig.name}`]);

			logger.success(`Floating IP: ${floatingIpConfig.name} created successfully: ${floatingIp.floating_ip_address}`);
			return floatingIp;
		} catch (error) {
			logger.error(`Failed to create floating IP: ${floatingIpConfig.name}: ${error?.response?.data?.NeutronError?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Add tags to an existing floating IP
	 * @param {String} floatingIpId - ID of the floating IP
	 * @param {Array} tags - Array of tags to add
	 * @returns {Promise<Object>} Updated floating IP
	 */
	async addTagsToFloatingIP(floatingIpId, tags) {
		try {
			logger.info(`Adding tags to floating IP ${floatingIpId}: ${tags.join(', ')}`);

			const authClient = this.getAuthenticatedAxios();

			const floatingIpResponse = await authClient.get(`network/v2.0/floatingips/${floatingIpId}`);
			const floatingIp = floatingIpResponse.data.floatingip;
			const existingTags = floatingIp.tags || [];

			const tagsToAdd = tags.filter((tag) => !existingTags.includes(tag));

			if (tagsToAdd.length === 0) {
				logger.info(`All tags already exist on floating IP ${floatingIpId}`);
				return floatingIp;
			}

			for (const tag of tagsToAdd) {
				logger.info(`Adding tag "${tag}" to floating IP ${floatingIpId}`);
				await authClient.put(`network/v2.0/floatingips/${floatingIpId}/tags/${tag}`);
			}

			const updatedResponse = await authClient.get(`network/v2.0/floatingips/${floatingIpId}`);
			const updatedFloatingIp = updatedResponse.data.floatingip;

			logger.success(`Tags added successfully to floating IP ${floatingIpId}`);
			return updatedFloatingIp;
		} catch (error) {
			logger.error(`Failed to add tags to floating IP ${floatingIpId}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get a floating IP by name
	 * @param {String} floatingIpName - Name of the floating IP
	 * @return {Promise<Object>} Floating IP object
	 */
	async getFloatingIP(floatingIpName) {
		try {
			logger.info(`Getting floating IP: ${floatingIpName}`);

			const authClient = this.getAuthenticatedAxios();
			const floatingIpsResponse = await authClient.get('network/v2.0/floatingips');
			const floatingIps = floatingIpsResponse.data.floatingips;

			const floatingIp = floatingIps.find((ip) => ip.tags && ip.tags.includes(`name:${floatingIpName}`));

			if (!floatingIp) {
				throw new Error(`Floating IP ${floatingIpName} not found`);
			}

			return floatingIp;
		} catch (error) {
			logger.error(`Failed to get floating IP: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Associate a floating IP with a server
	 * @param {String} floatingIpId - ID of the floating IP
	 * @param {String} networkName - Name of the network
	 * @param {String} serverId - ID of the server
	 */
	async associateFloatingIP(floatingIpId, networkName, serverId) {
		try {
			logger.info(`Associating floating IP ${floatingIpId} with server ${serverId}`);
			const portsResponse = await this._client.Network.portsGet();
			const ports = portsResponse.data.ports;

			const serverResponse = await this._client.Compute.serversIdGet(serverId);
			const server = serverResponse.data.server;

			if (!server) {
				throw new Error(`Server ${serverId} not found`);
			}

			const serverNetwork = server.addresses[networkName];

			if (ports.length === 0) {
				throw new Error(`No ports found for server ${serverId}`);
			}

			const port = ports.find((port) => {
				const fixedIp = port.fixed_ips.find((fixedIp) => fixedIp.ip_address === serverNetwork[0].addr);
				if (fixedIp) {
					logger.info(`Found port with IP ${fixedIp.ip_address} for server ${serverId}`);
					return port;
				}
			});

			if (!port) {
				throw new Error(`No port found for server ${serverId}`);
			}

			if (port.status !== 'ACTIVE') {
				throw new Error(`Port ${port.id} is not active`);
			}

			if (port.device_id !== serverId) {
				throw new Error(`Port ${port.id} is not attached to server ${serverId}`);
			}

			const authClient = this.getAuthenticatedAxios();

			await authClient.put(`network/v2.0/floatingips/${floatingIpId}`, {
				floatingip: {
					port_id: port.id,
				},
			});

			logger.success(`Floating IP associated with server successfully`);
		} catch (error) {
			logger.error(`Failed to associate floating IP: ${error?.response?.data?.NeutronError?.message || error.message}`);
			throw error;
		}
	}
}

const controller = new OpenStackController();

module.exports = controller;
