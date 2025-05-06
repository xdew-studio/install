/**
 * Cloudflare controller for DNS management using the official Cloudflare SDK
 */

const Cloudflare = require('cloudflare');
const logger = require('../utils/logger');

/**
 * Initialize Cloudflare client
 * @param {String} apiToken - Cloudflare API token
 * @returns {Object} - Cloudflare client with utility methods
 */
const initCloudflareClient = (apiToken) => {
	const client = new Cloudflare({
		apiToken: apiToken,
	});

	return {
		/**
		 * Get zone ID for a domain
		 * @param {String} domain - Domain to get zone ID for
		 * @returns {Promise<String>} - Zone ID
		 */
		getZoneId: async (domain) => {
			try {
				logger.info(`Getting Cloudflare zone ID for domain: ${domain}`);

				const response = await client.zones.list({
					name: domain,
				});

				if (response.result.length === 0) {
					throw new Error(`No zone found for domain: ${domain}`);
				}

				const zoneId = response.result[0].id;
				logger.success(`Found zone ID for ${domain}: ${zoneId}`);

				return zoneId;
			} catch (error) {
				logger.error(`Error getting zone ID: ${error.message}`);
				throw error;
			}
		},

		/**
		 * List DNS records for a zone
		 * @param {String} zoneId - Zone ID
		 * @param {Object} filters - Optional filters (type, name, etc.)
		 * @returns {Promise<Array>} - List of DNS records
		 */
		listDnsRecords: async (zoneId, filters = {}) => {
			try {
				logger.info(`Listing DNS records for zone: ${zoneId}`);

				const response = await client.dns.records.list({
					zone_id: zoneId,
					...filters,
				});

				logger.info(`Found ${response.result.length} DNS records`);
				return response.result;
			} catch (error) {
				logger.error(`Error listing DNS records: ${error.message}`);
				throw error;
			}
		},

		/**
		 * Create a DNS record
		 * @param {String} zoneId - Zone ID
		 * @param {Object} record - DNS record data
		 * @returns {Promise<Object>} - Created DNS record
		 */
		createDnsRecord: async (zoneId, record) => {
			try {
				logger.info(`Creating DNS record: ${record.type} ${record.name}`);

				const response = await client.dns.records.create({
					zone_id: zoneId,
					...record,
				});

				logger.success(`DNS record created successfully: ${record.type} ${record.name}`);
				return response.result;
			} catch (error) {
				logger.error(`Error creating DNS record: ${error.message}`);
				throw error;
			}
		},

		/**
		 * Update a DNS record
		 * @param {String} zoneId - Zone ID
		 * @param {String} recordId - Record ID
		 * @param {Object} record - Updated DNS record data
		 * @returns {Promise<Object>} - Updated DNS record
		 */
		updateDnsRecord: async (zoneId, recordId, record) => {
			try {
				logger.info(`Updating DNS record: ${recordId}`);

				const response = await client.dns.records.edit(recordId, {
					zone_id: zoneId,
					...record,
				});

				logger.success(`DNS record updated successfully: ${record.type} ${record.name}`);
				return response.result;
			} catch (error) {
				logger.error(`Error updating DNS record: ${error.message}`);
				throw error;
			}
		},

		/**
		 * Delete a DNS record
		 * @param {String} zoneId - Zone ID
		 * @param {String} recordId - Record ID
		 * @returns {Promise<Boolean>} - Success status
		 */
		deleteDnsRecord: async (zoneId, recordId) => {
			try {
				logger.info(`Deleting DNS record: ${recordId}`);

				await client.dnsRecords.del({
					zone_id: zoneId,
					id: recordId,
				});

				logger.success('DNS record deleted successfully');
				return true;
			} catch (error) {
				logger.error(`Error deleting DNS record: ${error.message}`);
				throw error;
			}
		},
	};
};

/**
 * Create or update a DNS record
 * @param {Object} client - Cloudflare client
 * @param {String} zoneId - Zone ID
 * @param {String} type - Record type (A, CNAME, etc.)
 * @param {String} name - Record name
 * @param {String} content - Record content (IP address, domain, etc.)
 * @param {Boolean} proxied - Whether the record is proxied
 * @param {Number} ttl - TTL for the record (1 for auto)
 * @returns {Promise<Object>} - Created or updated DNS record
 */
const createOrUpdateDnsRecord = async (client, zoneId, type, name, content, proxied = false, ttl = 1) => {
	try {
		logger.info(`Creating or updating DNS record: ${type} ${name}`);

		const existingRecords = await client.listDnsRecords(zoneId, { type, name });

		if (existingRecords.length > 0) {
			const existingRecord = existingRecords[0];

			if (existingRecord.content !== content || existingRecord.proxied !== proxied || existingRecord.ttl !== ttl) {
				return await client.updateDnsRecord(zoneId, existingRecord.id, {
					type,
					name,
					content,
					proxied,
					ttl,
				});
			}

			logger.info(`DNS record already exists with correct values: ${type} ${name}`);
			return existingRecord;
		}

		return await client.createDnsRecord(zoneId, {
			type,
			name,
			content,
			proxied,
			ttl,
		});
	} catch (error) {
		logger.error(`Error creating or updating DNS record: ${error.message}`);
		throw error;
	}
};

/**
 * Configure DNS records
 * @param {Object} cloudflareConfig - Cloudflare configuration
 * @param {Array} records - Array of record configurations
 * @returns {Promise<Array>} - Created or updated DNS records
 */
const configureDnsRecords = async (cloudflareConfig, records) => {
	try {
		logger.info(`Configuring ${records.length} DNS records`);

		const client = initCloudflareClient(cloudflareConfig.api_token);
		const zoneId = await client.getZoneId(cloudflareConfig.domain);

		const results = [];

		for (const record of records) {
			if (!record.type || !record.name || !record.content) {
				logger.warn(`Skipping invalid record: ${JSON.stringify(record)}`);
				continue;
			}

			const recordType = record.type;
			const recordName = record.name.includes(cloudflareConfig.domain) ? record.name : `${record.name}.${cloudflareConfig.domain}`;
			const recordContent = record.content;
			const recordProxied = record.proxied !== undefined ? record.proxied : false;
			const recordTtl = record.ttl !== undefined ? record.ttl : 1;

			const createdRecord = await createOrUpdateDnsRecord(client, zoneId, recordType, recordName, recordContent, recordProxied, recordTtl);

			results.push(createdRecord);
		}

		logger.success(`DNS configured successfully for ${results.length} records`);
		return results;
	} catch (error) {
		logger.error(`Failed to configure DNS records: ${error.message}`);
		throw error;
	}
};

/**
 * Configure DNS records for services (shorthand for configureDnsRecords with A records)
 * @param {Object} cloudflareConfig - Cloudflare configuration
 * @param {Array} recordNames - Record names (subdomains)
 * @param {String} ipAddress - IP address for services
 * @param {Boolean} proxied - Whether the records should be proxied
 * @param {Number} ttl - TTL for the records (1 for auto)
 * @returns {Promise<Array>} - Created or updated DNS records
 */
const configureServiceDns = async (cloudflareConfig, recordNames, ipAddress, proxied = true, ttl = 1) => {
	try {
		logger.info(`Configuring DNS for services: ${recordNames.join(', ')}`);

		const records = recordNames.map((name) => ({
			type: 'A',
			name: `${name}.${cloudflareConfig.domain}`,
			content: ipAddress,
			proxied,
			ttl,
		}));

		return await configureDnsRecords(cloudflareConfig, records);
	} catch (error) {
		logger.error(`Failed to configure DNS for services: ${error.message}`);
		throw error;
	}
};

/**
 * Configure DNS CNAME records for services
 * @param {Object} cloudflareConfig - Cloudflare configuration
 * @param {Array} recordNames - Record names (subdomains)
 * @param {String} targetHostname - Target hostname for CNAME records
 * @param {Boolean} proxied - Whether the records should be proxied
 * @param {Number} ttl - TTL for the records (1 for auto)
 * @returns {Promise<Array>} - Created or updated DNS records
 */
const configureServiceCnames = async (cloudflareConfig, recordNames, targetHostname, proxied = true, ttl = 1) => {
	try {
		logger.info(`Configuring CNAME records for services: ${recordNames.join(', ')}`);

		const records = recordNames.map((name) => ({
			type: 'CNAME',
			name: name,
			content: targetHostname,
			proxied,
			ttl,
		}));

		return await configureDnsRecords(cloudflareConfig, records);
	} catch (error) {
		logger.error(`Failed to configure CNAME records for services: ${error.message}`);
		throw error;
	}
};

module.exports = {
	initCloudflareClient,
	configureDnsRecords,
	configureServiceDns,
	configureServiceCnames,
};
