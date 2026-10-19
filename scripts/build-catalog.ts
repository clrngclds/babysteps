/**
 * Reads data/*.json, validates, drops verified:false items and writes
 *   public/catalog/v{N}/{milestones,activities,outings,milestone_to_activities}.json
 *   public/catalog/v{N}/by_month/{MM}.json
 *   public/catalog/latest.json
 * Usage: tsx scripts/build-catalog.ts   (CATALOG_VERSION=2 to bump the version)
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, buildCatalog, type RawData } from './catalog-lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));

const data: RawData = {
  activities: read('activities.json'),
  milestones: read('milestones.json'),
  outings: read('sg_outings.json'),
};

const { errors, warnings } = validate(data, { strictPublishedCoverage: process.env.CATALOG_STRICT === '1' });
for (const w of warnings) console.warn(`warn: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`Catalog validation failed with ${errors.length} error(s).`);
  process.exit(1);
}

const version = Number(process.env.CATALOG_VERSION ?? 1);
const built = buildCatalog(data, version, new Date().toISOString());
const outDir = join(root, 'public', 'catalog');
const vDir = join(outDir, `v${version}`);
rmSync(vDir, { recursive: true, force: true });
for (const [rel, value] of Object.entries(built.files)) {
  const p = join(vDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(value));
}
writeFileSync(join(outDir, 'latest.json'), JSON.stringify(built.latest));
console.log(
  `catalog v${version}: ${built.counts.activities} activities, ${built.counts.milestones} milestones, ` +
    `${built.counts.outings} outings, ${Object.keys(built.files).length} files`,
);
