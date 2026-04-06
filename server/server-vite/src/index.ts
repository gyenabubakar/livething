import { dirname, resolve } from 'node:path';
import { glob } from 'tinyglobby';
import type { Plugin } from 'vite';
import {
  ensureWskitTemplate,
  formatGeneratedPathForLog,
  removeGeneratedDeclarationFile,
  writeGeneratedDeclarationFile,
} from './generator.ts';
import type { WskitCodegenOptions } from './generator.ts';

export interface WskitVitePluginOptions extends WskitCodegenOptions {
  include?: string | string[];
}

function normalizeInclude(include?: string | string[]): string[] {
  if (!include) return ['**/*.wskit.ts'];
  return Array.isArray(include) ? include : [include];
}

type PluginLogger = {
  info(message: string): void;
  warn(message: string): void;
};

export function wskitCodegen(options: WskitVitePluginOptions = {}): Plugin {
  let root = process.cwd();
  let resolvedOutDir = resolve(root, options.outDir ?? '.wskit');
  const include = normalizeInclude(options.include);

  async function generateMatchingFiles(filePaths: string[], logger: PluginLogger) {
    for (const filePath of filePaths) {
      try {
        const templated = await ensureWskitTemplate(filePath);
        if (templated) {
          logger.info(`[wskit] templated ${formatGeneratedPathForLog(root, filePath)}`);
        }

        const generated = await writeGeneratedDeclarationFile(filePath, {
          ...options,
          outDir: resolvedOutDir,
          rootDir: root,
        });
        logger.info(`[wskit] generated ${formatGeneratedPathForLog(root, generated)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[wskit] ${message} (${formatGeneratedPathForLog(root, filePath)})`);
      }
    }
  }

  async function onChange(
    filePath: string,
    rootDir: string,
    includePatterns: string[],
    logger: PluginLogger,
  ) {
    const matches = await glob(includePatterns, {
      cwd: rootDir,
      absolute: true,
      ignore: ['**/*.d.ts', '**/node_modules/**', '**/dist/**'],
    });

    if (!matches.includes(resolve(filePath))) return;
    await generateMatchingFiles([resolve(filePath)], logger);
  }

  async function onUnlink(filePath: string, rootDir: string, includePatterns: string[]) {
    const absolute = resolve(filePath);
    if (
      !includePatterns.some((pattern) =>
        absolute.endsWith(pattern.replace('**/*', '').replace('*', '')),
      )
    ) {
      return;
    }

    await removeGeneratedDeclarationFile(absolute, {
      ...options,
      outDir: resolvedOutDir,
      rootDir,
    });
  }

  return {
    name: 'wskit-codegen',
    configResolved(config) {
      root = config.root;
      const configDir = config.configFile ? dirname(config.configFile) : root;
      resolvedOutDir = resolve(configDir, options.outDir ?? '.wskit');
    },
    async buildStart() {
      const files = await glob(include, {
        cwd: root,
        absolute: true,
        ignore: ['**/*.d.ts', '**/node_modules/**', '**/dist/**'],
      });

      await generateMatchingFiles(files, {
        info: (message) => this.info(message),
        warn: (message) => this.warn(message),
      });
    },
    configureServer(server) {
      const watcher = server.watcher;
      watcher.on('add', (filePath) => onChange(filePath, root, include, server.config.logger));
      watcher.on('change', (filePath) => onChange(filePath, root, include, server.config.logger));
      watcher.on('unlink', (filePath) => onUnlink(filePath, root, include));
    },
    async handleHotUpdate(ctx) {
      if (!ctx.file.endsWith('.wskit.ts')) return;
      await generateMatchingFiles([ctx.file], ctx.server.config.logger);
    },
  };
}

export type { WskitCodegenOptions } from './generator.ts';
