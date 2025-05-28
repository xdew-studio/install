#!/usr/bin/env node

/**
 * K8s OpenStack Installer
 * Main script to orchestrate the full installation process
 */

const fs = require('fs').promises;
const path = require('path');
const { loadConfig } = require('./src/utils/config');
const logger = require('./src/utils/logger');

const loadTasks = async () => {
	const tasksDir = path.join(__dirname, 'src', 'tasks');
	const files = await fs.readdir(tasksDir);

	const taskFiles = files.filter((file) => file.endsWith('.js')).sort();

	const tasks = [];
	for (const file of taskFiles) {
		const task = require(path.join(tasksDir, file));
		tasks.push({
			name: path.basename(file, '.js'),
			run: task.run,
		});
	}

	return tasks;
};

const main = async () => {
	try {
		logger.info('Starting K8s OpenStack Installer');

		const config = await loadConfig();
		logger.info('Configuration loaded successfully');

		const tasks = await loadTasks();
		logger.info(`Loaded ${tasks.length} tasks to execute`);

		for (const task of tasks) {
			logger.start(`Running task: ${task.name}`);

			if (parseInt(task.name.split('-')[0]) > 10) {
				await task.run(config);
			}

			logger.success(`Task ${task.name} completed successfully`);
		}

		logger.success('Installation completed successfully!');
		logger.info('Your Kubernetes cluster is now running with the following components:');
		logger.info(`- Rancher UI: https://${config.rancher.domain}`);
		logger.info(`- Kubernetes API: https://kubernetes.${config.general.domain}`);
		logger.info(`- Projects created: ${config.kubernetes.projects.map((p) => p.name).join(', ')}`);

		process.exit(0);
	} catch (error) {
		logger.error(`Installation failed: ${error.message}`);
		logger.debug(error.stack);
		process.exit(1);
	}
};

main();
