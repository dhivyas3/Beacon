import { startExternalSite, startFixtureSite } from './server.js';

/** `pnpm --filter @qa-hub/fixtures serve`: run the fixture site by hand at http://127.0.0.1:4010. */
const external = await startExternalSite({ port: 4011 });
const site = await startFixtureSite({ port: 4010, externalUrl: external.url });

console.log(`Fixture site:     ${site.url}`);
console.log(`External site:    ${external.url}`);
console.log('Scan it with ALLOW_LOCAL_TARGETS=true and 127.0.0.1 on the allowed domains list.');
console.log('Press Ctrl+C to stop.');

process.on('SIGINT', () => {
  void Promise.all([site.close(), external.close()]).then(() => process.exit(0));
});
