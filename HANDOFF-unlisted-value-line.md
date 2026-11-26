# Handoff: add inventory value + target line to the Unlisted Inventory Trend dashboard

**Artifact:** https://claude.ai/artifact/RX1ZkpnCYgSLe9BxyrLcpS ("Unlisted Inventory Trend")
**Data source:** the SPEEKSNET claude.ai connector (`run_query`), table `store_weekly_sales`.
The page reads a dataset called `weekly`, which is a live query on that connector.

Read the artifact first and build on what is there. Don't restyle it: the
report-email look (dark header band, sage stripe, store badge colours) is approved.

---

## What Ethan asked for

On the **top chart** (the company unlisted line-items trend):

1. **Inventory value line.** Add the total $ value of the unlisted pile on a
   **right-hand $ axis**, on the same chart, drawn under the existing item-count line.
2. **$100K goal line** on that right axis. The goal is **$20K or less of unlisted
   value per store × 5 stores = $100K company**.
3. **Target-items line** on the left (items) axis. This is how many unlisted line
   items the company can hold and still be at $100K:
   `target_items = 100,000 ÷ $ per item`.

### Decisions already made (don't re-ask)

- **"Rolloff" = unlisted pile value.** That is Sales Summary col Z
  (`store_weekly_sales.inventory_value`), on the same row as the unlisted
  line items (col X, `inventory_line_items`).
- **One company-wide $ per item**, not one per store. Ethan picked this.
- **$ per item = trailing 8-week weighted average**
  (sum of value ÷ sum of items over the last 8 weeks, not an average of weekly
  ratios). Ethan left this choice to us, and this one gives the clearest read
  of "how many total items do we need." A single week's ratio makes the line
  jumpy. A fixed number would be wrong for older weeks: $ per item has fallen
  from ~$150 in spring to ~$105 now.

## The data

Use the five stores only: `store in ('OVL','LEE','WSP','MPL','BAL')`. The table
also has a `Company` row, so leave that out or you'll double-count. Order weeks
by `synced_at`, not by `week_label`, because labels are inconsistent
("September wk1" was synced Oct 5).

```sql
with w as (
  select week_label, max(synced_at) synced_at,
         sum(inventory_line_items) items, sum(inventory_value) inv_value
  from store_weekly_sales
  where store in ('OVL','LEE','WSP','MPL','BAL') and inventory_value is not null
  group by week_label
)
select week_label, items, inv_value,
  round(inv_value/nullif(items,0),1) per_item,
  round(sum(inv_value) over w8 / nullif(sum(items) over w8,0),1) per_item_8wk,
  round(100000 / (sum(inv_value) over w8 / nullif(sum(items) over w8,0))) target_items
from w
window w8 as (order by synced_at rows between 7 preceding and current row)
order by synced_at;
```

**Important:** the dashboard already **skips stale re-imports**, meaning any
week whose five store counts exactly repeat an earlier week's (e.g. Aug 2-8 is
a copy of July wk2; "June 29-5"/"July 29-5" and several May/Apr weeks repeat
too). Apply that same filter **before** the 8-week window. The cleanest way is
to extend the existing `weekly` query with `sum(inventory_value)` rather than
writing a second query, so both lines share one set of weeks.

### Expected values (as of 2026-11-09), to check against

| Week | Items | Value | $/item | 8-wk $/item | Target items |
|---|---|---|---|---|---|
| Nov 1-7 | 2,636 | $277,443 | 105.3 | 107.4 | **931** |
| Oct 25-31 | 2,632 | $270,708 | 102.9 | 108.2 | 924 |
| Oct 18-24 | 2,683 | $289,946 | 108.1 | 109.4 | 914 |
| Oct 11-17 | 2,785 | $293,715 | 105.5 | 110.2 | 907 |
| Oct 4-10 | 2,841 | $313,545 | 110.4 | 111.8 | 895 |

The headline right now: **target ≈ 930 items vs 2,636 actual, about 1,700 over
(about $177K over the $100K goal).** It's worth showing as a callout or legend line.

## Display notes

- Left axis: line items (existing line + new target line, dashed).
- Right axis: $ (new value line + $100K goal line, dashed). Label with $ and K
  (e.g. $280K).
- The tooltip on hover should show items, value, $/item and target for that week.
- Use colours already in the page. Keep the two dashed lines visually
  tied to their axis (same hue as the solid line they belong to).
- Check it at phone width (390px) and in dark mode.

## Caveat to put in a footnote

This uses one company-wide $ per item. MPL and OVL run ~$125/item and LEE/BAL/WSP
run ~$80–90, so MPL/OVL could hit their share of the item target and still be over
$20K each. A per-store view would need per-store rates, which Ethan didn't ask for.

## After publishing

Tell Ethan the new latest target number. He'll forward the result back to the
Claude Code session that wrote this handoff.
