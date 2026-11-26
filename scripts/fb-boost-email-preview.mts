// Renders the Facebook Boosts email with sample data, no deploy needed:
//   node scripts/fb-boost-email-preview.mts scripts/fb-boost-email-preview.html
// then open the .html (port 8080 preview). Sample rows only; nothing is read or sent.
import { buildBoostEmail } from '../supabase/functions/fb-boost-report/email.ts';
import { writeFileSync } from 'node:fs';

const now = new Date('2026-11-16T14:00:00Z');
const at = (d: number) => new Date(now.getTime() + d * 864e5).toISOString();
const row = (store: string, sku: string, title: string, start: number, days: number, budget: number, by: string, done: string | null = null, doneAt: number | null = null) => ({
  store, sku, title, price: null, boostedAt: at(start), endsAt: at(start + days), days, budget, boostedBy: by,
  doneAt: doneAt === null ? null : at(doneAt),
});
const started = [
  row('LEE', 'MO01-6252A-F1R1', 'Sony PlayStation 5 Disc PS5 825GB White Console Gaming System CFI-1215A', -6, 7, 20, 'Jurell Guild', 'sold', -2),
  row('LEE', 'MO01-B2B197-QTY2-R1R2', 'Dell Vostro 15 5510 15.6" i7-11370H 3.0GHz 16GB RAM', -4, 5, 15, 'Jurell Guild'),
  row('OVL', 'KS01-8411A-E4', 'Apple iPhone 13 128GB Midnight Unlocked A2482', -3, 7, 25, 'Test Manager'),
  row('BAL', 'MO04-2210B-R1R1', 'Lenovo Legion Go 2 8.8" AMD Ryzen Z2 16GB 1TB', -2, 3, 10, 'Store Lister'),
];
const running = started.filter((r) => Date.parse(r.endsAt) > now.getTime() && !r.doneAt);
writeFileSync(process.argv[2], buildBoostEmail({ weekStart: '2026-11-09', weekEnd: '2026-11-15', now: now.toISOString(), started, running }));
console.log('wrote', process.argv[2]);
