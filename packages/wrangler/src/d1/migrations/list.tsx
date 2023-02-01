import path from "path";
import { Box, render, Text } from "ink";
import Table from "ink-table";
import React from "react";
import { withConfig } from "../../config";
import { logger } from "../../logger";
import { requireAuth } from "../../user";
import { DEFAULT_MIGRATION_PATH, DEFAULT_MIGRATION_TABLE } from "../constants";
import { d1BetaWarning, getDatabaseInfoFromConfig } from "../utils";
import {
	getMigrationsPath,
	getUnappliedMigrations,
	initMigrationsTable,
} from "./helpers";
import { DatabaseWithLocalAndPreview } from "./options";
import type {
	CommonYargsArgv,
	StrictYargsOptionsToInterface,
} from "../../yargs-types";

export function ListOptions(yargs: CommonYargsArgv) {
	return DatabaseWithLocalAndPreview(yargs);
}

type ListHandlerOptions = StrictYargsOptionsToInterface<typeof ListOptions>;

export const ListHandler = withConfig<ListHandlerOptions>(
	async ({ config, database, local, persistTo, preview }): Promise<void> => {
		logger.log(d1BetaWarning);
		if (local && preview) {
			throw new Error(
				`Can't use both --preview and --local.\n--preview runs this command against your preview D1 database, while --local runs your command against a local sqlite database.`
			);
		}
		if (!local) {
			await requireAuth({});
		}

		const databaseInfo = getDatabaseInfoFromConfig(config, database);
		if (!databaseInfo && !local) {
			throw new Error(
				`Can't find a DB with name/binding '${database}' in local config. Check info in wrangler.toml...`
			);
		}

		if (!config.configPath) {
			return;
		}

		const migrationsPath = await getMigrationsPath(
			path.dirname(config.configPath),
			databaseInfo?.migrationsFolderPath ?? DEFAULT_MIGRATION_PATH,
			false
		);

		const migrationsTableName =
			databaseInfo?.migrationsTableName ?? DEFAULT_MIGRATION_TABLE;

		await initMigrationsTable(
			migrationsTableName,
			local,
			config,
			database,
			persistTo
		);

		const unappliedMigrations = (
			await getUnappliedMigrations(
				migrationsTableName,
				migrationsPath,
				local,
				config,
				database,
				persistTo
			)
		).map((migration) => {
			return {
				Name: migration,
			};
		});

		if (unappliedMigrations.length === 0) {
			render(<Text>✅ No migrations to apply!</Text>);
			return;
		}

		render(
			<Box flexDirection="column">
				<Text>Migrations to be applied:</Text>
				<Table data={unappliedMigrations} columns={["Name"]}></Table>
			</Box>
		);
	}
);
