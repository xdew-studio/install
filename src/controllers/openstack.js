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

	/*
	 * Get a VM instance by id
	 * @param {String} vmId - ID of the VM instance
	 * @returns {Promise<Object>} VM instance
	 */
	async getVMById(vmId) {
		try {
			const serverResponse = await this._client.Compute.serversIdGet(vmId);
			return serverResponse.data.server;
		} catch (error) {
			logger.error(`Failed to get VM by ID: ${error.message}`);
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
			console.error(error.response?.data);
			logger.error(`Failed to create VM: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	async deleteVM(serverId) {
		try {
			logger.info(`Deleting VM: ${serverId}`);
			await this._client.Compute.serversIdDelete(serverId);
			logger.success(`VM ${serverId} deleted successfully`);
		} catch (error) {
			if (error.response?.data?.NeutronError?.message?.includes('Resource not found')) {
				logger.info(`VM ${serverId} not found, skipping deletion`);
				return;
			}

			logger.error(`Failed to delete VM: ${error.response?.data?.badRequest?.message || error.message}`);
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
				try {
					const serverResponse = await this._client.Compute.serversIdGet(serverId);
					const server = serverResponse.data.server;

					if (server.status === targetStatus) {
						logger.info(`Server ${serverId} reached status ${targetStatus}`);
						return server;
					}

					const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
					logger.progress(`Server status: ${server.status}, waiting for ${targetStatus}`, Math.floor((elapsedSeconds / timeout) * 100));
				} catch (error) {
					if (targetStatus === 'ABSENT' && error.response?.status === 404) {
						logger.info(`Server ${serverId} is absent as expected`);
						return null;
					}
					throw error;
				}

				await new Promise((resolve) => setTimeout(resolve, 5000));
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

	/**
	 * Create a load balancer if it doesn't exist
	 * @param {Object} lbConfig - Load balancer configuration
	 * @param {Object} resources - Resource mappings (networks, subnets, floating IPs)
	 * @returns {Promise<Object>} Created or existing load balancer
	 */
	async createLoadBalancer(lbConfig, resources) {
		try {
			logger.info(`Creating load balancer: ${lbConfig.name}`);

			const authClient = this.getAuthenticatedAxios();
			const loadBalancersResponse = await authClient.get('loadbalance/v2/loadbalancers');
			const loadBalancers = loadBalancersResponse.data.loadbalancers;
			const existingLB = loadBalancers.find((lb) => lb.name === lbConfig.name);

			if (existingLB) {
				logger.info(`Load balancer ${lbConfig.name} already exists, using existing load balancer`);
				return existingLB;
			}

			const subnet = resources.subnets.find((s) => s.name === lbConfig.subnet);
			if (!subnet) {
				throw new Error(`Subnet ${lbConfig.subnet} not found`);
			}

			const loadBalancerData = {
				name: lbConfig.name,
				vip_subnet_id: subnet.id,
				admin_state_up: true,
			};

			const loadBalancerResponse = await authClient.post('loadbalance/v2/loadbalancers', {
				loadbalancer: loadBalancerData,
			});

			const loadBalancer = loadBalancerResponse.data.loadbalancer;
			logger.success(`Load balancer ${lbConfig.name} created successfully`);

			if (lbConfig.floating_ip) {
				const floatingIp = resources.floatingIps.find((ip) => ip.name === lbConfig.floating_ip);
				if (floatingIp) {
					logger.info(`Associating floating IP ${floatingIp.name} with load balancer ${lbConfig.name}`);
					await this.associateFloatingIPWithLoadBalancer(floatingIp.id, loadBalancer.id);
				}
			}

			return loadBalancer;
		} catch (error) {
			logger.error(`Failed to create load balancer: ${error.response?.data?.faultstring || error.message}`);
			throw error;
		}
	}

	/**
	 * Associate a floating IP with a load balancer
	 * @param {String} floatingIpId - ID of the floating IP
	 * @param {String} loadBalancerId - ID of the load balancer
	 */
	async associateFloatingIPWithLoadBalancer(floatingIpId, loadBalancerId) {
		try {
			logger.info(`Associating floating IP ${floatingIpId} with load balancer ${loadBalancerId}`);

			const authClient = this.getAuthenticatedAxios();

			const loadBalancerResponse = await authClient.get(`loadbalance/v2/loadbalancers/${loadBalancerId}`);
			const loadBalancer = loadBalancerResponse.data.loadbalancer;

			if (!loadBalancer.vip_port_id) {
				throw new Error(`Load balancer ${loadBalancerId} does not have a VIP port ID`);
			}

			await authClient.put(`network/v2.0/floatingips/${floatingIpId}`, {
				floatingip: {
					port_id: loadBalancer.vip_port_id,
				},
			});

			logger.success(`Floating IP ${floatingIpId} associated with load balancer ${loadBalancerId} successfully`);
		} catch (error) {
			logger.error(`Failed to associate floating IP with load balancer: ${error.response?.data?.NeutronError?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Wait for a load balancer to reach a specific status
	 * @param {String} loadBalancerId - ID of the load balancer
	 * @param {String} targetStatus - Status to wait for
	 * @param {Number} timeout - Timeout in seconds
	 */
	async waitForLoadBalancerStatus(loadBalancerId, targetStatus, timeout = 300) {
		try {
			logger.waiting(`Waiting for load balancer ${loadBalancerId} to reach status ${targetStatus}`);

			const authClient = this.getAuthenticatedAxios();
			const startTime = Date.now();
			const endTime = startTime + timeout * 1000;

			while (Date.now() < endTime) {
				const loadBalancerResponse = await authClient.get(`loadbalance/v2/loadbalancers/${loadBalancerId}`);
				const loadBalancer = loadBalancerResponse.data.loadbalancer;

				if (loadBalancer.provisioning_status === targetStatus) {
					logger.info(`Load balancer ${loadBalancerId} reached status ${targetStatus}`);
					return loadBalancer;
				}

				await new Promise((resolve) => setTimeout(resolve, 5000));

				const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
				logger.progress(`Load balancer status: ${loadBalancer.provisioning_status}, waiting for ${targetStatus}`, Math.floor((elapsedSeconds / timeout) * 100));
			}

			throw new Error(`Timeout waiting for load balancer to reach status ${targetStatus}`);
		} catch (error) {
			logger.error(`Error waiting for load balancer status: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Wait for a volume to reach a specific status
	 * @param {String} volumeId - ID of the volume
	 * @param {String} targetStatus - Status to wait for
	 * @param {Number} timeout - Timeout in seconds
	 */
	async waitForVolumeStatus(volumeId, targetStatus, timeout = 300) {
		try {
			logger.waiting(`Waiting for volume ${volumeId} to reach status ${targetStatus}`);

			const startTime = Date.now();
			const endTime = startTime + timeout * 1000;

			while (Date.now() < endTime) {
				const volumeResponse = await openstackController._client.Volume.volumesVolumeIdGet(volumeId);
				const volume = volumeResponse.data.volume;

				if (volume.status === targetStatus) {
					logger.info(`Volume ${volumeId} reached status ${targetStatus}`);
					return volume;
				}

				await new Promise((resolve) => setTimeout(resolve, 5000));

				const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
				logger.progress(`Volume status: ${volume.status}, waiting for ${targetStatus}`, Math.floor((elapsedSeconds / timeout) * 100));
			}

			throw new Error(`Timeout waiting for volume to reach status ${targetStatus}`);
		} catch (error) {
			logger.error(`Error waiting for volume status: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create a volume
	 * @param {Object} volumeConfig - Volume configuration object
	 * @returns {Promise<Object>} Created volume
	 */
	async createVolume(volumeConfig) {
		try {
			logger.info(`Creating volume: ${volumeConfig.name}`);

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			const volumes = this.getVolumes({
				name: volumeConfig.name,
			});

			if (volumes.length > 0) {
				logger.info(`Volume ${volumeConfig.name} already exists, using existing volume`);
				return volume[0];
			}

			const volumeResponse = await authClient.post(`${volumeServiceEndpoint}/volumes`, {
				volume: {
					name: volumeConfig.name,
					size: volumeConfig.size,
					description: volumeConfig.description || `Volume for ${volumeConfig.name}`,
					volume_type: volumeConfig.volume_type,
					metadata: volumeConfig.metadata || {},
				},
			});

			const volume = volumeResponse.data.volume;
			logger.success(`Created volume: ${volume.name} (${volume.id})`);

			return volume;
		} catch (error) {
			logger.error(`Failed to create volume: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	async updateVolume(volumeId, volumeConfig) {
		try {
			logger.info(`Updating volume: ${volumeId}`);

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			const volume = await this.getVolumeById(volumeId);

			const volumeResponse = await authClient.put(`${volumeServiceEndpoint}/volumes/${volumeId}`, {
				volume: {
					name: volumeConfig.name || volume.name,
					description: volumeConfig.description || volume.description || `Volume for ${volumeConfig.name}`,
					metadata: volumeConfig.metadata || volume.metadata || {},
				},
			});

			const updatedVolume = volumeResponse.data.volume;
			logger.success(`Updated volume: ${updatedVolume.name} (${updatedVolume.id})`);

			return updatedVolume;
		} catch (error) {
			logger.error(`Failed to update volume: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Get volume by ID
	 * @param {String} volumeId - ID of the volume
	 * @returns {Promise<Object>} Volume object
	 */
	async getVolumeById(volumeId) {
		try {
			logger.info(`Getting volume with ID: ${volumeId}`);

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			const volumeResponse = await authClient.get(`${volumeServiceEndpoint}/volumes/${volumeId}`);
			const volume = volumeResponse.data.volume;

			return volume;
		} catch (error) {
			logger.error(`Failed to get volume: ${error.response?.data?.itemNotFound?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Get volumes list
	 * @param {Object} filters - Optional filters for volumes
	 * @returns {Promise<Array>} List of volumes
	 */
	async getVolumes(filters = {}) {
		try {
			logger.info('Getting volumes list');

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			// Build query parameters for filtering
			const queryParams = new URLSearchParams();
			Object.entries(filters).forEach(([key, value]) => {
				queryParams.append(key, value);
			});

			const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
			const volumesResponse = await authClient.get(`${volumeServiceEndpoint}/volumes/detail${queryString}`);

			const volumes = volumesResponse.data.volumes;
			logger.info(`Retrieved ${volumes.length} volumes`);

			return volumes;
		} catch (error) {
			logger.error(`Failed to get volumes: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get the volume service endpoint from the catalog
	 * @returns {String} Volume service endpoint URL
	 */
	getVolumeServiceEndpoint() {
		if (!this._client || this._client.isTokenExpired()) {
			throw new Error('Authentication token expired. Please authenticate first.');
		}

		const volumeService = this._client._catalog.find((entry) => entry.type === 'volumev3' || entry.type === 'volume');
		if (!volumeService || !volumeService.endpoints) {
			throw new Error('Volume service not found in catalog');
		}

		const endpoint = volumeService.endpoints.find((ep) => ep.interface === 'public');
		if (!endpoint || !endpoint.url) {
			throw new Error('Public endpoint not found for volume service');
		}

		return endpoint.url;
	}

	/**
	 * Wait for a volume to reach a specific status
	 * @param {String} volumeId - ID of the volume
	 * @param {String} targetStatus - Status to wait for
	 * @param {Number} timeout - Timeout in seconds
	 * @returns {Promise<Object>} Volume object
	 */
	async waitForVolumeStatus(volumeId, targetStatus, timeout = 300) {
		try {
			logger.waiting(`Waiting for volume ${volumeId} to reach status ${targetStatus}`);

			const startTime = Date.now();
			const endTime = startTime + timeout * 1000;

			while (Date.now() < endTime) {
				const volume = await this.getVolumeById(volumeId);

				if (volume.status.toLowerCase() === targetStatus.toLowerCase()) {
					logger.info(`Volume ${volumeId} reached status ${targetStatus}`);
					return volume;
				}

				await new Promise((resolve) => setTimeout(resolve, 5000));

				const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
				logger.progress(`Volume status: ${volume.status}, waiting for ${targetStatus}`, Math.floor((elapsedSeconds / timeout) * 100));
			}

			throw new Error(`Timeout waiting for volume to reach status ${targetStatus}`);
		} catch (error) {
			logger.error(`Error waiting for volume status: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Delete a volume
	 * @param {String} volumeId - ID of the volume to delete
	 * @returns {Promise<void>}
	 */
	async deleteVolume(volumeId) {
		try {
			logger.info(`Deleting volume with ID: ${volumeId}`);

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			await authClient.delete(`${volumeServiceEndpoint}/volumes/${volumeId}`);
			logger.success(`Successfully deleted volume ${volumeId}`);
		} catch (error) {
			logger.error(`Failed to delete volume: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Attach a volume to a server
	 * @param {String} volumeId - ID of the volume
	 * @param {String} serverId - ID of the server
	 * @param {String} device - Device path (optional)
	 * @returns {Promise<Object>} Attachment information
	 */
	async attachVolumeToServer(volumeId, serverId, device = null) {
		try {
			logger.info(`Attaching volume ${volumeId} to server ${serverId}`);

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			const attachmentData = {
				volumeAttachment: {
					volumeId: volumeId,
					device: device || `/dev/vdb`,
				},
			};

			if (device) {
				attachmentData.volumeAttachment.device = device;
			}

			const existingVolumeResponse = await authClient.get(`volume/v3/volumes/${volumeId}`);
			const existingVolume = existingVolumeResponse.data.volume;
			const existingAttachment = existingVolume.attachments.find((a) => a.server_id === serverId);
			if (existingAttachment) {
				logger.info(`Volume ${volumeId} is already attached to server ${serverId}`);
				return existingVolume;
			}

			// First, wait for the volume to be available
			await this.waitForVolumeStatus(volumeId, 'available');

			// Then attach it to the server
			const computeServiceEndpoint = this.getComputeServiceEndpoint();
			const attachmentResponse = await authClient.post(`${computeServiceEndpoint}/servers/${serverId}/os-volume_attachments`, attachmentData);

			const attachment = attachmentResponse.data.volumeAttachment;
			logger.success(`Volume ${volumeId} attached to server ${serverId}`);

			// Wait for the volume to be in-use
			await this.waitForVolumeStatus(volumeId, 'in-use');

			return attachment;
		} catch (error) {
			logger.error(`Failed to attach volume: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Get compute service endpoint from the catalog
	 * @returns {String} Compute service endpoint URL
	 */
	getComputeServiceEndpoint() {
		if (!this._client || this._client.isTokenExpired()) {
			throw new Error('Authentication token expired. Please authenticate first.');
		}

		const computeService = this._client._catalog.find((entry) => entry.type === 'compute');
		if (!computeService || !computeService.endpoints) {
			throw new Error('Compute service not found in catalog');
		}

		const endpoint = computeService.endpoints.find((ep) => ep.interface === 'public');
		if (!endpoint || !endpoint.url) {
			throw new Error('Public endpoint not found for compute service');
		}

		return endpoint.url;
	}

	/**
	 * Detach a volume from a server
	 * @param {String} volumeId - ID of the volume
	 * @param {String} serverId - ID of the server
	 * @returns {Promise<void>}
	 */
	async detachVolumeFromServer(volumeId, serverId) {
		try {
			logger.info(`Detaching volume ${volumeId} from server ${serverId}`);

			const authClient = this.getAuthenticatedAxios();
			const computeServiceEndpoint = this.getComputeServiceEndpoint();

			// Get attachment ID
			const serverResponse = await authClient.get(`${computeServiceEndpoint}/servers/${serverId}/os-volume_attachments`);
			const attachments = serverResponse.data.volumeAttachments;
			const attachment = attachments.find((a) => a.volumeId === volumeId);

			if (!attachment) {
				throw new Error(`Volume ${volumeId} is not attached to server ${serverId}`);
			}

			// Detach the volume
			await authClient.delete(`${computeServiceEndpoint}/servers/${serverId}/os-volume_attachments/${volumeId}`);
			logger.success(`Volume ${volumeId} detached from server ${serverId}`);

			// Wait for the volume to be available again
			await this.waitForVolumeStatus(volumeId, 'available');
		} catch (error) {
			logger.error(`Failed to detach volume: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Create bootable volume from image
	 * @param {Object} volumeConfig - Volume configuration
	 * @param {String} imageId - ID of the image
	 * @returns {Promise<Object>} Created volume
	 */
	async createBootableVolume(volumeConfig, imageId) {
		try {
			logger.info(`Creating bootable volume: ${volumeConfig.name} from image ${imageId}`);

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			const volumeResponse = await authClient.post(`${volumeServiceEndpoint}/volumes`, {
				volume: {
					name: volumeConfig.name,
					size: volumeConfig.size,
					description: volumeConfig.description || `Bootable volume from image ${imageId}`,
					availability_zone: volumeConfig.availability_zone,
					imageRef: imageId,
					bootable: true,
					volume_type: volumeConfig.volume_type,
					metadata: volumeConfig.metadata || {},
				},
			});

			const volume = volumeResponse.data.volume;
			logger.success(`Created bootable volume: ${volume.name} (${volume.id})`);

			await this.waitForVolumeStatus(volume.id, 'available');

			return volume;
		} catch (error) {
			logger.error(`Failed to create bootable volume: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Get volume snapshots
	 * @param {Object} filters - Optional filters for snapshots
	 * @returns {Promise<Array>} List of volume snapshots
	 */
	async getVolumeSnapshots(filters = {}) {
		try {
			logger.info('Getting volume snapshots');

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			// Build query parameters for filtering
			const queryParams = new URLSearchParams();
			Object.entries(filters).forEach(([key, value]) => {
				queryParams.append(key, value);
			});

			const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
			const snapshotsResponse = await authClient.get(`${volumeServiceEndpoint}/snapshots/detail${queryString}`);

			const snapshots = snapshotsResponse.data.snapshots;
			logger.info(`Retrieved ${snapshots.length} volume snapshots`);

			return snapshots;
		} catch (error) {
			logger.error(`Failed to get volume snapshots: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Create a volume snapshot
	 * @param {String} volumeId - ID of the volume
	 * @param {Object} snapshotConfig - Snapshot configuration
	 * @returns {Promise<Object>} Created snapshot
	 */
	async createVolumeSnapshot(volumeId, snapshotConfig) {
		try {
			logger.info(`Creating snapshot of volume ${volumeId}: ${snapshotConfig.name}`);

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			const snapshotResponse = await authClient.post(`${volumeServiceEndpoint}/snapshots`, {
				snapshot: {
					volume_id: volumeId,
					name: snapshotConfig.name,
					description: snapshotConfig.description || `Snapshot of volume ${volumeId}`,
					force: snapshotConfig.force || false,
				},
			});

			const snapshot = snapshotResponse.data.snapshot;
			logger.success(`Created snapshot: ${snapshot.name} (${snapshot.id}) of volume ${volumeId}`);

			return snapshot;
		} catch (error) {
			logger.error(`Failed to create volume snapshot: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Create a volume from snapshot
	 * @param {String} snapshotId - ID of the snapshot
	 * @param {Object} volumeConfig - Volume configuration
	 * @returns {Promise<Object>} Created volume
	 */
	async createVolumeFromSnapshot(snapshotId, volumeConfig) {
		try {
			logger.info(`Creating volume from snapshot ${snapshotId}: ${volumeConfig.name}`);

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			const volumeResponse = await authClient.post(`${volumeServiceEndpoint}/volumes`, {
				volume: {
					name: volumeConfig.name,
					size: volumeConfig.size,
					description: volumeConfig.description || `Volume from snapshot ${snapshotId}`,
					snapshot_id: snapshotId,
					availability_zone: volumeConfig.availability_zone,
					volume_type: volumeConfig.volume_type,
					metadata: volumeConfig.metadata || {},
				},
			});

			const volume = volumeResponse.data.volume;
			logger.success(`Created volume from snapshot: ${volume.name} (${volume.id})`);

			await this.waitForVolumeStatus(volume.id, 'available');

			return volume;
		} catch (error) {
			logger.error(`Failed to create volume from snapshot: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Extend volume size
	 * @param {String} volumeId - ID of the volume
	 * @param {Number} newSize - New size in GB
	 * @returns {Promise<Object>} Updated volume
	 */
	async extendVolume(volumeId, newSize) {
		try {
			logger.info(`Extending volume ${volumeId} to ${newSize}GB`);

			const volume = await this.getVolumeById(volumeId);

			if (volume.size >= newSize) {
				logger.warn(`Volume ${volumeId} is already ${volume.size}GB, which is greater than or equal to requested size ${newSize}GB`);
				return volume;
			}

			const authClient = this.getAuthenticatedAxios();
			const volumeServiceEndpoint = this.getVolumeServiceEndpoint();

			await authClient.post(`${volumeServiceEndpoint}/volumes/${volumeId}/action`, {
				'os-extend': {
					new_size: newSize,
				},
			});

			logger.success(`Extended volume ${volumeId} to ${newSize}GB`);

			// Wait for volume to be available again
			await this.waitForVolumeStatus(volumeId, 'available');

			// Get the updated volume
			const updatedVolume = await this.getVolumeById(volumeId);
			return updatedVolume;
		} catch (error) {
			logger.error(`Failed to extend volume: ${error.response?.data?.badRequest?.message || error.message}`);
			throw error;
		}
	}

	/**
	 * Create a load balancer listener
	 * @param {Object} listenerConfig - Listener configuration
	 * @returns {Promise<Object>} Created listener
	 */
	async createLoadBalancerListener(listenerConfig) {
		try {
			logger.info(`Creating load balancer listener: ${listenerConfig.name}`);

			const authClient = this.getAuthenticatedAxios();
			const listenersResponse = await authClient.get('loadbalance/v2/listeners');
			const listeners = listenersResponse.data.listeners;
			const existingListener = listeners.find((l) => l.name === listenerConfig.name);

			if (existingListener) {
				logger.info(`Listener ${listenerConfig.name} already exists, using existing listener`);
				return existingListener;
			}

			await this.waitForLoadBalancerStatus(listenerConfig.loadbalancer_id, 'ACTIVE');

			const listenerResponse = await authClient.post('loadbalance/v2/listeners', {
				listener: {
					name: listenerConfig.name,
					protocol: listenerConfig.protocol,
					protocol_port: listenerConfig.protocol_port,
					loadbalancer_id: listenerConfig.loadbalancer_id,
					admin_state_up: true,
				},
			});

			const listener = listenerResponse.data.listener;
			logger.success(`Listener ${listenerConfig.name} created successfully`);

			await this.waitForLoadBalancerStatus(listenerConfig.loadbalancer_id, 'ACTIVE');

			return listener;
		} catch (error) {
			logger.error(`Failed to create listener: ${error.response?.data?.faultstring || error.message}`);
			throw error;
		}
	}

	/**
	 * Create a load balancer pool
	 * @param {Object} poolConfig - Pool configuration
	 * @returns {Promise<Object>} Created pool
	 */
	async createLoadBalancerPool(poolConfig) {
		try {
			logger.info(`Creating load balancer pool: ${poolConfig.name}`);

			const authClient = this.getAuthenticatedAxios();
			const poolsResponse = await authClient.get('loadbalance/v2/pools');
			const pools = poolsResponse.data.pools;
			const existingPool = pools.find((p) => p.name === poolConfig.name);

			if (existingPool) {
				logger.info(`Pool ${poolConfig.name} already exists, using existing pool`);
				return existingPool;
			}

			await this.waitForLoadBalancerStatus(poolConfig.loadbalancer_id, 'ACTIVE');

			const poolData = {
				name: poolConfig.name,
				protocol: poolConfig.protocol,
				lb_algorithm: poolConfig.lb_algorithm,
				admin_state_up: true,
			};

			if (poolConfig.listener_id) {
				poolData.listener_id = poolConfig.listener_id;
			} else if (poolConfig.loadbalancer_id) {
				poolData.loadbalancer_id = poolConfig.loadbalancer_id;
			}

			const poolResponse = await authClient.post('loadbalance/v2/pools', {
				pool: poolData,
			});

			const pool = poolResponse.data.pool;
			logger.success(`Pool ${poolConfig.name} created successfully`);

			await this.waitForLoadBalancerStatus(poolConfig.loadbalancer_id, 'ACTIVE');

			return pool;
		} catch (error) {
			logger.error(`Failed to create pool: ${error.response?.data?.faultstring || error.message}`);
			throw error;
		}
	}

	/**
	 * Create a health monitor
	 * @param {Object} monitorConfig - Health monitor configuration
	 * @returns {Promise<Object>} Created health monitor
	 */
	async createHealthMonitor(monitorConfig) {
		try {
			logger.info(`Creating health monitor: ${monitorConfig.name}`);

			const authClient = this.getAuthenticatedAxios();
			const monitorsResponse = await authClient.get('loadbalance/v2/healthmonitors');
			const monitors = monitorsResponse.data.healthmonitors;
			const existingMonitor = monitors.find((m) => m.name === monitorConfig.name);

			if (existingMonitor) {
				logger.info(`Health monitor ${monitorConfig.name} already exists, using existing monitor`);
				return existingMonitor;
			}

			await this.waitForLoadBalancerStatus(monitorConfig.loadbalancer_id, 'ACTIVE');

			const monitorResponse = await authClient.post('loadbalance/v2/healthmonitors', {
				healthmonitor: {
					name: monitorConfig.name,
					pool_id: monitorConfig.pool_id,
					type: monitorConfig.type,
					delay: monitorConfig.delay,
					timeout: monitorConfig.timeout,
					max_retries: monitorConfig.max_retries,
					max_retries_down: monitorConfig.max_retries_down,
					http_method: monitorConfig.http_method,
					url_path: monitorConfig.url_path,
					expected_codes: monitorConfig.expected_codes,
					admin_state_up: true,
				},
			});

			const monitor = monitorResponse.data.healthmonitor;
			logger.success(`Health monitor ${monitorConfig.name} created successfully`);

			await this.waitForLoadBalancerStatus(monitorConfig.loadbalancer_id, 'ACTIVE');

			return monitor;
		} catch (error) {
			logger.error(`Failed to create health monitor: ${error.response?.data?.faultstring || error.message}`);
			throw error;
		}
	}

	/**
	 * Add a member to a load balancer pool
	 * @param {Object} memberConfig - Pool member configuration
	 * @returns {Promise<Object>} Created pool member
	 */
	async addPoolMember(memberConfig) {
		try {
			logger.info(`Adding member ${memberConfig.name} to pool ${memberConfig.pool_id}`);

			const authClient = this.getAuthenticatedAxios();

			const membersResponse = await authClient.get(`loadbalance/v2/pools/${memberConfig.pool_id}/members`);
			const members = membersResponse.data.members;
			const existingMember = members.find((m) => m.address === memberConfig.address && m.protocol_port === memberConfig.protocol_port);

			if (existingMember) {
				logger.info(`Member with address ${memberConfig.address} and port ${memberConfig.protocol_port} already exists in pool ${memberConfig.pool_id}`);
				return existingMember;
			}

			await this.waitForLoadBalancerStatus(memberConfig.loadbalancer_id, 'ACTIVE');

			const memberData = {
				name: memberConfig.name,
				address: memberConfig.address,
				protocol_port: memberConfig.protocol_port,
				subnet_id: memberConfig.subnet_id,
				admin_state_up: true,
			};

			if (memberConfig.monitor_port) {
				memberData.monitor_port = memberConfig.monitor_port;
			}

			const memberResponse = await authClient.post(`loadbalance/v2/pools/${memberConfig.pool_id}/members`, {
				member: memberData,
			});

			const member = memberResponse.data.member;
			logger.success(`Member ${memberConfig.name} added to pool ${memberConfig.pool_id} successfully`);

			await this.waitForLoadBalancerStatus(memberConfig.loadbalancer_id, 'ACTIVE');

			return member;
		} catch (error) {
			logger.error(`Failed to add member to pool: ${error.response?.data?.faultstring || error.message}`);
			throw error;
		}
	}
}

const controller = new OpenStackController();

module.exports = controller;
