// ============================================================
// SPEEKS — B2B acceptance emails: read them out of one Drive folder
//
// Paul drags the client's acceptance email out of Outlook and into a Google
// Drive folder. That gesture WORKS, reliably, from every version of Outlook —
// and the reason is worth writing down, because three releases of SPEEKSNET were
// spent trying to replace it:
//
//   Dragging into a Drive-for-desktop folder is an OS-LEVEL drop. Windows offers
//   the message as a "virtual file" (FileGroupDescriptorW + FileContents) and
//   Explorer fully supports that format, so it asks for the bytes and writes the
//   .msg. It has nothing to do with Google.
//
//   Dragging into a WEB PAGE is a different mechanism, and the new Outlook puts
//   nothing on it but a pointer — {"subjects":[...],"latestItemIds":[...]}, a
//   reference to the message on Microsoft's server. No body, no headers, no
//   bytes. Measured, 2026-09-10. Unfixable from a browser at any price.
//
// So SPEEKSNET stopped trying to be the drop target and reads the folder Paul is
// already dropping into instead. He keeps the gesture that works; the site
// fetches the file and files it against the deal.
//
// WHY APPS SCRIPT AND NOT A SUPABASE FUNCTION:
//   this runs as the Google account that OWNS the folder, so it gets Drive
//   access with no OAuth client, no consent screen and no refresh tokens — the
//   same trick sales-email-import.gs uses for Gmail.
//
// WHO CALLS IT: only the b2b-deals edge function, server to server. NEVER the
// browser. speeks.js is static and readable by anyone who can load the page, so
// a shared secret in it is not a secret. The edge function holds SHARED_SECRET
// in its own environment and this script is unreachable without it.
//
// SETUP (one-time):
//   1. Sign in as the Google account that owns the B2B acceptance folder.
//   2. Create a standalone Apps Script project and paste this file in.
//   3. Project Settings → Script Properties, add two:
//        FOLDER_ID      the folder's id — the part of its URL after /folders/
//        SHARED_SECRET  a long random string. Generate one, don't invent one.
//   4. Run diagnoseDriveFolder() once. Authorize when prompted, then read the
//      log: it confirms the folder resolves, says how many files are in it and
//      lists the newest few. Do this BEFORE deploying — an authorization prompt
//      cannot appear to a server-to-server caller, so an unauthorized script
//      just fails for reasons that look like something else.
//   5. Deploy → New deployment → Web app, "Execute as me",
//      "Who has access: Anyone". It has to be Anyone because the caller is a
//      Deno function with no Google identity; the secret is what guards it.
//   6. Copy the /exec URL. In Supabase → Edge Functions → Secrets set:
//        B2B_DRIVE_URL     that /exec URL
//        B2B_DRIVE_SECRET  the same SHARED_SECRET
//   7. Redeploy b2b-deals so it picks the secrets up.
//
// RE-DEPLOYING: use "Manage deployments" and edit the existing deployment, or
// the /exec URL changes and B2B_DRIVE_URL has to be updated with it.
// ============================================================

// How many files to look at. DriveApp gives no way to ask for "newest first",
// so the listing walks the folder and sorts what it finds — which means the cap
// is a real limit, not a page size. 400 is far more than a folder of acceptance
// emails will hold, and keeps the call well inside the execution limit.
var DRIVE_SCAN_CAP = 400;

// Returned to the caller. Deliberately small: the site only needs enough to
// show a list and let somebody pick the right row.
function fileRow_(f) {
  return {
    id: f.getId(),
    name: f.getName(),
    bytes: f.getSize(),
    mime: f.getMimeType(),
    modified: f.getLastUpdated().toISOString(),
  };
}

function out_(obj, code) {
  // Apps Script cannot set a status code on a ContentService response, so the
  // status travels in the body and the edge function reads it from there.
  var body = obj || {};
  if (code) body.status = code;
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) { return handle_(e); }
function doPost(e) { return handle_(e); }

function handle_(e) {
  try {
    var p = (e && e.parameter) ? e.parameter : {};
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('SHARED_SECRET');
    if (!secret) return out_({ error: 'SHARED_SECRET script property is not set' }, 500);
    // Constant-time comparison is not available here and not worth faking. The
    // secret is long and random, and the endpoint returns nothing on a miss.
    if (String(p.secret || '') !== secret) return out_({ error: 'unauthorized' }, 401);

    var folderId = props.getProperty('FOLDER_ID');
    if (!folderId) return out_({ error: 'FOLDER_ID script property is not set' }, 500);

    if (p.action === 'list') return out_({ files: listRecent_(folderId, Number(p.limit) || 25) });
    if (p.action === 'file') return out_(readOne_(folderId, String(p.id || '')));
    return out_({ error: 'unknown action: ' + String(p.action || '') }, 400);
  } catch (err) {
    return out_({ error: String((err && err.message) || err) }, 500);
  }
}

// Newest first. Everything in the folder is returned, whatever it is called --
// the same lesson the drop zone learned the hard way: refusing a real email for
// how it happens to be named is a worse failure than listing a stray file, and
// the person picking from this list can see which is which.
function listRecent_(folderId, limit) {
  var folder = DriveApp.getFolderById(folderId);
  var it = folder.getFiles();
  var rows = [];
  var scanned = 0;
  while (it.hasNext() && scanned < DRIVE_SCAN_CAP) {
    scanned++;
    rows.push(fileRow_(it.next()));
  }
  rows.sort(function (a, b) { return a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0; });
  return rows.slice(0, Math.max(1, Math.min(100, limit)));
}

// THE FOLDER CHECK IS THE SECURITY CONTROL, NOT A TIDINESS ONE.
//
// Without it this endpoint reads ANY file the deploying account can see, to
// anyone holding the secret — every spreadsheet, every contract, the lot. The id
// arrives from outside, so it is checked against the folder's parents before a
// single byte is read.
function readOne_(folderId, id) {
  if (!id) return { error: 'no file id' };
  var file;
  try { file = DriveApp.getFileById(id); }
  catch (_) { return { error: 'that file is not there any more' }; }

  var inFolder = false;
  var parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) { inFolder = true; break; }
  }
  if (!inFolder) return { error: 'that file is not in the B2B folder' };

  var blob = file.getBlob();
  return {
    id: file.getId(),
    name: file.getName(),
    mime: file.getMimeType(),
    bytes: file.getSize(),
    // base64 rather than raw: this travels as JSON, and a .msg is a binary
    // compound-file container that would not survive being treated as text.
    data: Utilities.base64Encode(blob.getBytes()),
  };
}

// ------------------------------------------------------------
// Run this from the editor BEFORE deploying. An authorization prompt cannot
// appear to a server-to-server caller, so an unauthorized script fails in ways
// that look like a configuration problem somewhere else entirely.
// ------------------------------------------------------------
function diagnoseDriveFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('FOLDER_ID');
  var secret = props.getProperty('SHARED_SECRET');
  Logger.log('FOLDER_ID set:     %s', folderId ? 'yes' : 'NO — set it in Script Properties');
  Logger.log('SHARED_SECRET set: %s', secret ? 'yes (' + secret.length + ' chars)' : 'NO — set it');
  if (!folderId) return;

  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (err) {
    Logger.log('COULD NOT OPEN THE FOLDER: %s', err && err.message);
    Logger.log('Check the id, and that this account can actually see the folder.');
    return;
  }
  Logger.log('folder name:       %s', folder.getName());

  var it = folder.getFiles();
  var n = 0;
  while (it.hasNext() && n < DRIVE_SCAN_CAP) { n++; it.next(); }
  Logger.log('files in it:       %s%s', n, n >= DRIVE_SCAN_CAP ? ' (hit the scan cap)' : '');

  var recent = listRecent_(folderId, 5);
  if (!recent.length) {
    Logger.log('The folder is empty. Drag an email into it and run this again.');
    return;
  }
  Logger.log('newest %s:', recent.length);
  recent.forEach(function (r) {
    Logger.log('  %s  ·  %s bytes  ·  %s', r.name, r.bytes, r.modified);
  });
  Logger.log('Now deploy: Web app, "Execute as me", "Anyone".');
}
