import { join } from "path";
import { FrameworkMap } from "frameworks/index";
import { readJSON } from "helpers/files";
import { fetch } from "undici";
import { describe, expect, test, afterEach, beforeEach } from "vitest";
import { deleteProject } from "../scripts/e2eCleanup";
import { frameworkToTest } from "./frameworkToTest";
import {
	isQuarantineMode,
	keys,
	runC3,
	testDeploymentCommitMessage,
	testProjectDir,
} from "./helpers";
import type { RunnerConfig } from "./helpers";

const TEST_TIMEOUT = 1000 * 60 * 3;

type FrameworkTestConfig = RunnerConfig & {
	expectResponseToContain: string;
	testCommitMessage: boolean;
	timeout?: number;
	unsupportedPms?: string[];
};

describe.concurrent(`E2E: Web frameworks`, () => {
	// These are ordered based on speed and reliability for ease of debugging
	const frameworkTests: Record<string, FrameworkTestConfig> = {
		astro: {
			expectResponseToContain: "Hello, Astronaut!",
			testCommitMessage: true,
		},
		docusaurus: {
			expectResponseToContain: "Dinosaurs are cool",
			unsupportedPms: ["bun"],
			testCommitMessage: true,
		},
		gatsby: {
			expectResponseToContain: "Gatsby!",
			unsupportedPms: ["bun"],
			promptHandlers: [
				{
					matcher: /Would you like to use a template\?/,
					input: ["n"],
				},
			],
			testCommitMessage: true,
			timeout: 1000 * 60 * 6,
		},
		hono: {
			expectResponseToContain: "Hello Hono!",
			testCommitMessage: false,
		},
		qwik: {
			expectResponseToContain: "Welcome to Qwik",
			promptHandlers: [
				{
					matcher: /Yes looks good, finish update/,
					input: [keys.enter],
				},
			],
			testCommitMessage: true,
		},
		remix: {
			expectResponseToContain: "Welcome to Remix",
			testCommitMessage: true,
			quarantine: true,
		},
		next: {
			expectResponseToContain: "Create Next App",
			promptHandlers: [
				{
					matcher: /Do you want to use the next-on-pages eslint-plugin\?/,
					input: ["y"],
				},
			],
			testCommitMessage: true,
			quarantine: true,
		},
		nuxt: {
			expectResponseToContain: "Welcome to Nuxt!",
			overrides: {
				packageScripts: {
					build: "NITRO_PRESET=cloudflare-pages nuxt build",
				},
			},
			testCommitMessage: true,
		},
		react: {
			expectResponseToContain: "React App",
			testCommitMessage: true,
		},
		solid: {
			expectResponseToContain: "Hello world",
			promptHandlers: [
				{
					matcher: /Which template do you want to use/,
					input: [keys.enter],
				},
				{
					matcher: /Server Side Rendering/,
					input: [keys.enter],
				},
				{
					matcher: /Use TypeScript/,
					input: [keys.enter],
				},
			],
			testCommitMessage: true,
		},
		svelte: {
			expectResponseToContain: "SvelteKit app",
			promptHandlers: [
				{
					matcher: /Which Svelte app template/,
					input: [keys.enter],
				},
				{
					matcher: /Add type checking with TypeScript/,
					input: [keys.down, keys.enter],
				},
				{
					matcher: /Select additional options/,
					input: [keys.enter],
				},
			],
			testCommitMessage: true,
		},
		vue: {
			expectResponseToContain: "Vite App",
			testCommitMessage: true,
		},
	};

	const { getPath, getName, clean } = testProjectDir("pages");

	beforeEach((ctx) => {
		const framework = ctx.meta.name;
		clean(framework);
	});

	afterEach(async (ctx) => {
		const framework = ctx.meta.name;
		clean(framework);
		// Cleanup the pages project in case we need to retry it
		const projectName = getName(framework);
		try {
			await deleteProject(projectName);
		} catch (error) {
			console.error(`Failed to cleanup project: ${projectName}`);
			console.error(error);
		}
	});

	const runCli = async (
		framework: string,
		{ argv = [], promptHandlers = [], overrides }: RunnerConfig
	) => {
		const projectPath = getPath(framework);

		const args = [
			projectPath,
			"--type",
			"webFramework",
			"--framework",
			framework,
			"--deploy",
			"--no-open",
			"--no-git",
		];

		args.push(...argv);

		const { output } = await runC3({
			argv: args,
			promptHandlers,
			outputPrefix: `[${framework}]`,
		});

		// Relevant project files should have been created
		expect(projectPath).toExist();
		const pkgJsonPath = join(projectPath, "package.json");
		expect(pkgJsonPath).toExist();

		// Wrangler should be installed
		const wranglerPath = join(projectPath, "node_modules/wrangler");
		expect(wranglerPath).toExist();

		// Verify package scripts
		const frameworkConfig = FrameworkMap[framework];

		const frameworkTargetPackageScripts = {
			...frameworkConfig.packageScripts,
		} as Record<string, string>;

		if (overrides && overrides.packageScripts) {
			// override packageScripts with testing provided scripts
			Object.entries(overrides.packageScripts).forEach(([target, cmd]) => {
				frameworkTargetPackageScripts[target] = cmd;
			});
		}

		const pkgJson = readJSON(pkgJsonPath);
		Object.entries(frameworkTargetPackageScripts).forEach(([target, cmd]) => {
			expect(pkgJson.scripts[target]).toEqual(cmd);
		});

		return { output };
	};

	const runCliWithDeploy = async (
		framework: string,
		testCommitMessage: boolean
	) => {
		const { argv, overrides, promptHandlers, expectResponseToContain } =
			frameworkTests[framework];

		const { output } = await runCli(framework, {
			overrides,
			promptHandlers,
			argv: [...(argv ?? [])],
		});

		// Verify deployment
		const deployedUrlRe =
			/deployment is ready at: (https:\/\/.+\.(pages|workers)\.dev)/;

		const match = output.match(deployedUrlRe);
		if (!match || !match[1]) {
			expect(false, "Couldn't find deployment url in C3 output").toBe(true);
			return;
		}

		const projectUrl = match[1];

		const res = await fetch(projectUrl);
		expect(res.status).toBe(200);

		const body = await res.text();
		expect(
			body,
			`(${framework}) Deployed page (${projectUrl}) didn't contain expected string: "${expectResponseToContain}"`
		).toContain(expectResponseToContain);

		if (testCommitMessage) {
			await testDeploymentCommitMessage(getName(framework), framework);
		}
	};

	Object.keys(frameworkTests).forEach((framework) => {
		const { quarantine, timeout, testCommitMessage, unsupportedPms } =
			frameworkTests[framework];

		const quarantineModeMatch = isQuarantineMode() == (quarantine ?? false);

		// If the framework in question is being run in isolation, always run it.
		// Otherwise, only run the test if it's configured `quarantine` value matches
		// what is set in E2E_QUARANTINE
		let shouldRun = frameworkToTest
			? frameworkToTest === framework
			: quarantineModeMatch;

		// Skip if the package manager is unsupported
		shouldRun &&= !unsupportedPms?.includes(process.env.TEST_PM ?? "");

		test.runIf(shouldRun)(
			framework,
			async () => {
				await runCliWithDeploy(framework, testCommitMessage);
			},
			{ retry: 3, timeout: timeout || TEST_TIMEOUT }
		);
	});

	test.skip("Hono (wrangler defaults)", async () => {
		await runCli("hono", { argv: ["--wrangler-defaults"] });
	});
});
