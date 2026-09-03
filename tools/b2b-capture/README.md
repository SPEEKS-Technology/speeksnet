# B2B capture and collate

Two scripts that take a bench batch from "four laptops on chargers" to a
review sheet you can price from, and a JSON file that imports into the B2B
pipeline without a mapping layer.

Nothing here touches `speeks.js`, the edge functions or the schema. It reads
machines and writes files. Wiring the JSON into SPEEKSnet is a separate,
later step.

## The two halves

### `SPEEKS-Capture.ps1` — runs on each test machine

Double-click `RUN-CAPTURE.bat` once Windows is up. It self-elevates (battery
health and panel size live in `root\wmi` and want admin), reads the machine,
asks the three things only a person can answer, and writes one JSON per unit
named after its serial.

Reads automatically:

| Field | Source |
|---|---|
| serial | `Win32_BIOS`, falling back to `Win32_SystemEnclosure` |
| make / model | `Win32_ComputerSystem`, with the Lenovo quirk handled (see below) |
| item_type | chassis type, so laptop vs desktop is not a guess |
| cpu | `Win32_Processor`, normalised to `i7-12700H` shape |
| ram | `Win32_PhysicalMemory`, falling back to total physical for soldered memory |
| storage | `Get-PhysicalDisk`, so SSD and HDD are told apart |
| gpu | `Win32_VideoController`, discrete only — integrated is noise |
| screen | panel size from EDID, snapped to real sizes, plus resolution and touch |
| battery_health | design capacity vs current full charge |
| windows edition, OEM key | `Win32_OperatingSystem`, `SoftwareLicensingService` |

Asks: condition, certified wipe, notes. Plus a client-facing reason when the
condition is Broken or For Parts, because `submit_pricing` refuses those lines
without one.

**The Lenovo quirk:** `Win32_ComputerSystem.Model` holds the MTM
(`82TF000RUS`) and the readable name (`Legion S7 16IAH7`) lives on
`Win32_ComputerSystemProduct.Version`. Every other maker puts the readable
name in `.Model`. Both are kept — `model` and `model_code`.

Options:

```powershell
.\SPEEKS-Capture.ps1                                   # writes beside itself
.\SPEEKS-Capture.ps1 -OutDir D:\ -AlsoCopyTo \\PC\Drop # second copy, best-effort
.\SPEEKS-Capture.ps1 -NoPrompt                         # specs only, no questions
.\SPEEKS-Capture.ps1 -Session 7KQ4MP                   # also post to a live session
.\SPEEKS-Capture.ps1 -Live                             # ask for the session code
```

The USB is the default destination on purpose: it is the one location that is
always present and needs no network. `-AlsoCopyTo` is attempted only after the
local write has already succeeded, so a dead share costs a warning, not data.

### `SPEEKS-Collate.ps1` — runs on your PC

```powershell
.\SPEEKS-Collate.ps1 -CaptureDir D:\captures -OutDir .\out -BatchName "Spencer Fane"
```

Folds identical units into line items, orders them, builds the eBay links, and
writes `batch.html` (work from this) and `batch.json` (Nick imports this).

**Grouping.** Same make, model, type, cpu, ram, storage, gpu, condition and
wipe flag becomes one line with a quantity and a comma-separated serial pool,
which is exactly the format `b2b_deal_items.serials` wants.

Screen is deliberately *not* part of the key. A laptop tested while docked
reports no panel, and one null must not split an otherwise identical pallet
into two lines. Panels are collected instead, and a real disagreement is
flagged for a manual split. Battery health is not in the key either, for the
same reason — it is reported as a range.

**Ordering.** Type, then brand, then model family, then spec strength, then
model. Families and brands sort by their strongest member, so all the Legions
sit above all the ThinkPads when the best Legion beats the best ThinkPad.

This orders by a spec-strength proxy, **not** by offer — offer does not exist
yet at this point in the flow. The proxy is in one clearly marked block near
the top of the file, and it is meant to be replaced with real offer once
prices come back.

**Pre-flight checks**, mirroring the gates in `b2b-deals`:

- lines missing CPU, RAM or storage (`unspeccedNames`)
- Broken / For Parts with no client reason (`unreasonedNames`)
- serial count vs quantity (`unserialledNames`)
- mixed panels on one line

All four are surfaced in the sheet and the console, so nothing is discovered
at submit time.

## Import shape

Every key in `batch.json` `lines[]` is a real field on `b2b_deal_items`.
Nothing needs remapping:

```
make  model  item_type  cpu  ram  storage  gpu  battery_health
condition  quantity  serials  staff_notes  client_notes
listing_info  wipe_required  disposition
```

Keys prefixed `_` are for the review sheet only and should be dropped on
import (`_research`, `_sort_rank`).

`disposition` defaults to `purchase`. `value` and `offer` are deliberately
absent: they are pricing decisions and belong to the pricing pass.

The eBay research link goes in `listing_info`, not `staff_notes` —
`staff_notes` caps at 1000 characters and is read while pricing, while
`listing_info` caps at 2000 and exists for whoever lists the item. A
300-character URL belongs in the roomy one.

## Live intake over wifi (optional)

A pricer with the sheet open clicks **Start a session** and gets a six-character
code. Run capture with `-Session <code>` (or `-Live` to be asked for it) and the
machine posts its own reading straight into that deal as well as writing the USB
copy. It appears in a tray above the pricing sheet within a second or two, and a
person clicks **Accept** to turn it into a line item.

Three things worth knowing:

- **It is a second destination, never the only one.** The USB JSON is written and
  confirmed *before* the network is touched, so a laptop with no wifi driver, a
  mistyped code or a dead access point costs nothing — the capture is already on
  the stick and collates exactly as it always did. Three retries, then it gives
  up quietly.
- **Nothing lands unattended.** A submission is inert until a human accepts it.
  The code is the only credential a device holds, it is scoped to one deal, it
  expires in 12 hours, and it can be closed from the sheet at any point.
- **Identical machines roll up.** The server applies the same nine-field key
  `SPEEKS-Collate.ps1` uses, so the second identical laptop becomes *quantity 2
  with two serials* rather than a second line — and the tray says which it will
  be before you click. Anything already priced on that line is left alone.

Without `-Session` or `-Live`, the script behaves exactly as it did before this
was added. The USB route is not deprecated and is still the fallback.

## Fixed since 0.1.0

Four reads were wrong. All four are verified against real hardware:

| Field | Was | Now |
|---|---|---|
| `ram` | `34GB` on a 32GB machine — divided by `1e9`, and the ±1 snap only masked it up to 16GB | binary `1GB`; correct 4GB–128GB |
| `storage` | `480GB` on a 512GB drive — first tier within 8%, scanning ascending, so 480 beat 512 (and 240 beat 256) | nearest tier wins |
| `screen` | `27.2"` on a 14" laptop — took whichever display answered first, i.e. the dock's monitor | internal panel only, via `VideoOutputTechnology`; native resolution off the panel's own EDID |
| `gpu` | `Arc 130V` sold as discrete — it is Lunar Lake integrated graphics | only `Arc A###`/`B###` count as discrete |

Also: `model` no longer repeats the make (`HP HP OmniBook…`), which was leading
every generated eBay query with a phrase no buyer types.

`battery_health` still reads null unless the script is elevated — `RUN-CAPTURE.bat`
self-elevates, so use that on the bench rather than calling the `.ps1` directly.
Worth one elevated run to confirm the WMI read works at all.

## Requirements

Windows PowerShell 5.1, which ships with Windows. No runtime, no modules, no
internet, nothing to install on a machine that was imaged twenty minutes ago.
