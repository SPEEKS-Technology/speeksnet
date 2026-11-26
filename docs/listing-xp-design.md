# Listing XP — the SPEEKSNET Arcade (design)

A game for listers: they score points from what they list, the store fights a
daily "boss" (the listing target), the month's score turns into tickets on the
1st with sold % as the bonus round, and tickets are spent at the Prize Counter.
The arcade page is built (`arcade.html`, section LISTING XP ARCADE at the end of
`speeks.js`) on sample numbers; the formula and the data behind it are still
being designed with Ethan, one piece at a time.

Status: **design in progress, nothing final.** Every number in the app is
`ARC_SAMPLE`.

---

## Achievements (approved 2026-11-18)

Ethan: "I really like the trophy stuff. I like daily, weekly, monthly and yearly
achievements." Then, of the catalog below: "I like all of those." The points an
achievement is worth wait for the formula (see *Revisit before finalizing*).

**On screen (built 2026-11-18, sample numbers):**
- **Play shows yesterday's dailies.** A person's listed count only exists once
  the Day End report lands (~5am the next morning), and the POS has no live
  per-person feed, so there is no foolproof "today". Earned yesterday = lit;
  earned before = faded; never = grey. Bottom-left reads "Yesterday · 3 of 7
  Earned"; no lifetime totals on the shelf (Ethan, 11-18).
- **Bigger periods join the shelf when they close:** last week's weeklies on a
  Monday, last month's monthlies on the 1st, last year's yearlies on Jan 1, each
  row with its own "Last Week · 2 of 6 Earned" line. Rarer rows go on top.
- **"All achievements"** opens the full set: totals, then every badge grouped by
  cadence with how it's earned. No filter (removed 11-18).
- **A count bubble on every badge**: how many times it has ever been earned.
- **A shape per cadence, an icon per achievement**: daily = coin, weekly =
  shield, monthly = octagon crest, yearly = medal on ribbons, milestone = dark
  diamond (`_arcBadge` in speeks.js).

### Ground rules

1. **Only measured data.** Every achievement comes from the Day End report, the
   title checker, the monthly sold % report, returns/claims, or the game's own
   records. Nothing anyone ticks themselves.
2. **Nothing for volume alone.** Anything that rewards a count also needs clean
   titles, or is measured against the person's own average. Otherwise the
   achievements pay for exactly the sloppy volume the game exists to stop.
3. **Fair to part-timers.** Rankings go per day worked, and "beat yourself" goals
   use the person's own history. Lifetime milestones are the only plain totals.
4. **A flagged day earns nothing** (repricing on a player's login, a suspected
   split lot) until the manager clears the flag.
5. **Ties: everyone tied earns it.**
6. **Repeatable vs once.** Daily, weekly and monthly achievements can be earned
   again and show a count (×12). Yearly ones are once per calendar year and go on
   a Hall of Fame wall. Milestones are once ever.
7. **Points (later):** bigger the longer the cadence. Daily < weekly < monthly <
   yearly, with milestones separate. Daily ones will need a per-day cap.

**Data key:**
- **DE**: Day End, per person. Available now.
- **TC**: title checker per person. Needs the Shopify lister tag on every listing (MPL was ~20% on 11-05).
- **SR**: PayMore's monthly sold % report per person.
- **RC**: returns and claims per person. Needs to know who listed each item.
- **G**: the game's own records (scores, levels, ranks).

### Daily — reset every day, repeatable

| Achievement | How you earn it | Data |
|---|---|---|
| Clean Sweep | List 5+ items and every title passes | TC |
| Boss Slayer | Your store beats the boss and you listed 5+ | DE |
| Day MVP | Most listed in your store, with no more than 1 title sent back | DE + TC |
| Personal Best | Beat your own best day, with no more than 1 title sent back | DE + TC |
| Above Average | List 25% more than your own 30-day daily average | DE |
| High Roller | List $2,000+ of value in a day (amount TBD) | DE |
| Carry the Team | 40%+ of your store's listings on a day it beats the boss | DE |

### Weekly — Monday to Sunday, repeatable

| Achievement | How you earn it | Data |
|---|---|---|
| Spotless Week | 5 work days in a row with every title passing | TC |
| Boss Rush | Store beats the boss 5+ days and you listed on each | DE |
| Steady Hand | At or above your own average every day you worked (3+ days) | DE |
| Week MVP | Top score in your store for the week | G |
| Big Game Hunter | Highest listed value in your store for the week | DE |
| Comeback Kid | Store loses the boss, then wins the next 3 days, and you listed on each | DE |

### Monthly — awarded at the 1st's cash-out, repeatable

| Achievement | How you earn it | Data |
|---|---|---|
| Clean Month | Nothing you listed came back (return or "not as described"), 50+ listed | RC |
| Sell-Through | Your sold % beats your store's | SR |
| Top of the Store | #1 score in your store | G |
| District Champ | #1 in the district, per day worked | G |
| Boss Season | Store beats the boss 15+ days and you listed on 10+ of them | DE |
| Margin Keeper | Your listed value vs cost at or above your store's for the month | DE |
| Iron Lister | Listed on every day you worked | DE |
| Level Up | Gained a level this month | G |
| Triple Crown | Sell-Through + Clean Month + top 3 in your store, same month | SR + RC + G |

### Yearly — once per calendar year, Hall of Fame

| Achievement | How you earn it | Data |
|---|---|---|
| Player of the Year | Highest score per day worked in the district | G |
| Store MVP of the Year | Highest score per day worked in your store | G |
| Marathon | Listed on 200+ days | DE |
| Boss Hunter | Part of 100+ boss wins | DE |
| Hat Trick | Top of the Store in 3+ months | G |
| Most Improved | Biggest jump in score per day, first half of the year vs second | G |
| Year of Clean | 6+ Clean Months | RC |
| Sell-Through Streak | Beat your store's sold % in 9+ months | SR |

### Milestones — once ever

| Achievement | How you earn it | Data |
|---|---|---|
| First 10 / 100 Club / 500 Club / 1,000 Club / 5,000 Club / 10,000 Club | Lifetime listings | DE |
| One per level: Apprentice → The Standard | Reach that level | G |
| First Blood / Boss Legend | First boss win / 50 boss wins | DE |
| Year One | A full year in the game | G |

**Count:** 7 daily, 6 weekly, 9 monthly, 8 yearly and 18 milestones, so 48 in all.
About 39 of them work on data we have today (Day End plus the game's own
records); the rest wait on the lister tag, the sold % report or per-person
returns.

**Screens:** see *On screen* above. Still an idea, not built: the yearly ones
also hanging on a Hall of Fame wall in High Scores.

---

## Revisit before finalizing

Ethan's rule (2026-11-18): anything he says to revisit has to be settled before
this is final. Kept in step with memory `listing-xp-revisit-list`.

Parked by Ethan:
- [ ] How To Play section on the Play screen
- [ ] Prize Counter: items, ticket prices, level locks, monthly caps, budget, hand-over
- [ ] Points for hitting an achievement (after the formula)
- [ ] The formula itself, tested on real past data
- [ ] A buyers' game, so nobody avoids buying shifts
- [ ] Managers as players
- [ ] Tablet and mobile layout
- [ ] Retiring per-role listing goals, and fixing what reads them (matrix rule, goal results, Store Efficiency)

Still open:
- [ ] How PayMore's per-person sold % report defines sold % (margin and returns in it?)
- [ ] Who sets the starting price: lister or buyer
- [ ] Per-person quality source (lister tag coverage)
- [ ] Day End "processed" vs "listed": does processed earn anything?
- [ ] Team boss bonus: approve it
- [ ] Can takebacks take a balance below zero?
- [ ] A player who reprices: flag only, or automatic takeback?
- [ ] Naming: score turns into tickets on the 1st
- [ ] Levels: lifetime or monthly reset
- [x] This achievement catalog: cut and approve (all 48 approved 11-18)
- [ ] High Roller's $2,000 bar and the other thresholds in the catalog (set with the formula)
- [ ] Store leaderboard on raw totals (11-18) favours bigger teams; per player-day was the fairness fix. Confirm.
- [ ] Real data in place of `ARC_SAMPLE`; the one-store pilot plan
