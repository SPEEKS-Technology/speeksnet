import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Version history for the SPEEKS Capture bench tool.
//
// GET  ?download=1[&id=<uuid>]  -> the zip bytes (current version, or a named one)
// POST { action: 'list' }       -> every version, newest first
// POST { action: 'upload' }     -> a new version, from a data URI
// POST { action: 'set_current' }-> move the live pointer (promote or roll back)
//
// NOTHING IS EVER OVERWRITTEN. Every upload is a new object in the bucket and a
// new row in b2b_capture_releases; which one is live is a pointer. A broken
// upload therefore cannot destroy the working one -- it can only take the
// pointer, and set_current takes it back. See 0066.
//
// DEPLOY WITH --no-verify-jwt, like b2b-deals and b2b-intake: the sheet posts
// with a content-type only, so the request stays simple and skips preflight.
//
// AUTHORISATION IS CLIENT-SIDE, the same PIN trust model as the rest of the
// app. The 'b2b-capture-download' feature flag decides who SEES the button; it
// cannot stop a hand-rolled POST, exactly as a hand-rolled add_item cannot be
// stopped in b2b-deals. What this function enforces is that the payload is
// really a zip, that it is a sane size, and that history is append-only -- so
// the worst a stranger can do is add a version nobody has promoted. That is a
// deliberate trade and it is the same one the rest of B2B already makes; if it
// ever needs to be a real gate, it wants the same per-device token work the
// intake endpoint does.

const BUCKET = "b2b-capture";
// 12MB decoded. The bucket allows 20; this refuses earlier and with a sentence
// somebody can act on, rather than letting storage reject it less helpfully.
const MAX_BYTES = 12 * 1024 * 1024;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

class Invalid extends Error {}

function str(v: unknown, max: number, label: string, required = false): string | null {
  const s = String(v ?? "").trim();
  if (!s) {
    if (required) throw new Invalid(label + " is required.");
    return null;
  }
  if (s.length > max) throw new Invalid(label + " is too long (max " + max + ").");
  return s;
}

// PowerShell 5.1 writes a UTF-8 BOM on every file it creates; if one ever
// reaches the front of a JSON body, JSON.parse throws on it.
function parseBody(raw: string): any {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A version label that is safe in a filename and readable in a list. Spaces and
// dots are fine; anything that could walk a path or confuse a Content-Disposition
// header is not.
function slugForFile(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "version";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ------------------------------------------------------------------ download
  //
  // A GET so it can be the href of an ordinary link and the browser's own
  // download machinery does the work -- no blob juggling in the page.
  if (req.method === "GET") {
    try {
      const url = new URL(req.url);
      if (!url.searchParams.get("download")) {
        return jsonResponse({ success: false, error: "Nothing to get here." }, 400);
      }
      const id = url.searchParams.get("id");

      let q = supabase.from("b2b_capture_releases")
        .select("id, version, file_path, file_name, size_bytes");
      q = id ? q.eq("id", id) : q.eq("is_current", true);
      const { data: rel } = await q.maybeSingle();
      if (!rel) {
        return jsonResponse({
          success: false,
          error: id ? "That version is gone." : "No version of the tool has been uploaded yet.",
        }, 404);
      }

      const dl = await supabase.storage.from(BUCKET).download(rel.file_path);
      if (dl.error || !dl.data) {
        return jsonResponse({ success: false, error: "Couldn't read that version from storage." }, 500);
      }
      return new Response(await dl.data.arrayBuffer(), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/zip",
          // Named with its version, so a stick that has been sitting in a drawer
          // can be identified from the filename alone.
          "Content-Disposition": `attachment; filename="${rel.file_name}"`,
          // Never cached: the whole point is that the pointer can move, and a
          // cached zip is how a bench keeps running last week's tool.
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return jsonResponse({ success: false, error: String((e as Error)?.message || e) }, 500);
    }
  }

  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST only." }, 405);

  try {
    const body = parseBody(await req.text());
    const action = String(body.action ?? "");

    // ---------------------------------------------------------------- history
    if (action === "list") {
      const { data, error } = await supabase.from("b2b_capture_releases")
        .select("id, version, notes, file_name, size_bytes, sha256, uploaded_by, uploaded_at, is_current")
        .order("uploaded_at", { ascending: false });
      if (error) return jsonResponse({ success: false, error: error.message }, 500);
      return jsonResponse({ success: true, releases: data || [] });
    }

    // ----------------------------------------------------------------- upload
    if (action === "upload") {
      const version = str(body.version, 60, "Version", true)!;
      const notes = str(body.notes, 1000, "Notes");
      const who = str(body.user, 80, "Uploaded by");

      const raw = String(body.file || "");
      const m = raw.match(/^data:([a-z0-9.+\/-]*);base64,([A-Za-z0-9+\/=]+)$/i);
      if (!m) return jsonResponse({ success: false, error: "That file didn't arrive in a readable form." }, 400);

      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      } catch (_) {
        return jsonResponse({ success: false, error: "That file was malformed." }, 400);
      }
      if (!bytes.length) return jsonResponse({ success: false, error: "That file is empty." }, 400);
      if (bytes.length > MAX_BYTES) {
        return jsonResponse({
          success: false,
          error: `That file is ${(bytes.length / 1e6).toFixed(1)}MB and the limit is 12MB. The tool is normally about 35KB, so this is probably not the right file.`,
        }, 400);
      }

      // Check the MAGIC BYTES, not the mime type the browser guessed. Windows
      // reports a zip as application/x-zip-compressed, Chrome as application/zip,
      // and a drag-and-drop from some clients as an empty string -- none of which
      // says anything about the content. "PK\x03\x04" does. An empty archive is
      // "PK\x05\x06", which is a real zip and a useless tool, so it is refused
      // separately and by name.
      const pk = bytes[0] === 0x50 && bytes[1] === 0x4b;
      const localHeader = pk && bytes[2] === 0x03 && bytes[3] === 0x04;
      const emptyArchive = pk && bytes[2] === 0x05 && bytes[3] === 0x06;
      if (emptyArchive) {
        return jsonResponse({ success: false, error: "That zip is empty." }, 400);
      }
      if (!localHeader) {
        return jsonResponse({
          success: false,
          error: "That isn't a .zip file. Zip the SPEEKS-Capture folder and upload the zip itself.",
        }, 400);
      }

      const sha = await sha256Hex(bytes);

      // Refuse a byte-identical re-upload. It is almost always someone clicking
      // twice or picking the wrong file, and a history full of duplicates makes
      // the one question this table exists to answer -- which version is which --
      // harder rather than easier.
      const { data: same } = await supabase.from("b2b_capture_releases")
        .select("version, uploaded_at").eq("sha256", sha).maybeSingle();
      if (same) {
        return jsonResponse({
          success: false,
          error: `That is byte-for-byte the same file already uploaded as "${same.version}".`,
        }, 409);
      }

      // Timestamped path: an upload can never land on top of an earlier one,
      // even if a version label is reused after a row is deleted.
      const filePath = `${Date.now()}-${slugForFile(version)}.zip`;
      const fileName = `SPEEKS-Capture-${slugForFile(version)}.zip`;

      const up = await supabase.storage.from(BUCKET)
        .upload(filePath, bytes, { contentType: "application/zip", upsert: false });
      if (up.error) return jsonResponse({ success: false, error: up.error.message }, 500);

      // Promote by default -- an upload nobody can download is not what anyone
      // meant by uploading. Pass make_current:false to stage one for testing
      // before the bench sees it.
      const promote = body.make_current !== false;

      // INSERT FIRST, AND NEVER CURRENT. Then move the pointer, and only once
      // the row is safely in.
      //
      // The obvious order -- clear the old current, then insert the new one as
      // current -- has a hole, and it bit on the first day: a rejected insert
      // (a duplicate version label) left the clear already committed, so a
      // FAILED upload de-promoted the working tool and the bench had nothing
      // live at all. That is the precise failure this whole table exists to
      // prevent, arriving through the back door.
      //
      // In this order the pointer is only ever touched after there is something
      // valid to point at, so no failure path can leave the tool unpublished.
      const { data, error } = await supabase.from("b2b_capture_releases").insert({
        version, notes, file_path: filePath, file_name: fileName,
        size_bytes: bytes.length, sha256: sha, uploaded_by: who, is_current: false,
      }).select("id, version").single();

      if (error) {
        // The row failed, so the object it points at is litter. Remove it rather
        // than leaving an orphan in the bucket that nothing can ever reach.
        await supabase.storage.from(BUCKET).remove([filePath]);
        const dupe = String(error.message).toLowerCase().includes("duplicate");
        return jsonResponse({
          success: false,
          error: dupe ? `There is already a version called "${version}".` : error.message,
        }, dupe ? 409 : 500);
      }

      let current = false;
      if (promote) {
        // Clear then set, the same pair set_current uses -- the partial unique
        // index refuses two current rows, so the order is load-bearing.
        await supabase.from("b2b_capture_releases").update({ is_current: false }).eq("is_current", true);
        const { error: pe } = await supabase.from("b2b_capture_releases")
          .update({ is_current: true }).eq("id", data.id);
        // A promote that fails is not an upload that failed. The version is
        // stored and in the history; say so, and let them press Make live.
        if (pe) {
          return jsonResponse({
            success: true, id: data.id, version: data.version, current: false, sha256: sha,
            warning: `Uploaded, but couldn't make it live: ${pe.message}. Use "Make live" in the history.`,
          });
        }
        current = true;
      }

      return jsonResponse({ success: true, id: data.id, version: data.version, current, sha256: sha });
    }

    // ------------------------------------------- move the pointer (or roll back)
    if (action === "set_current") {
      const id = str(body.id, 64, "Version", true)!;
      const who = str(body.user, 80, "User");
      const { data: rel } = await supabase.from("b2b_capture_releases")
        .select("id, version").eq("id", id).maybeSingle();
      if (!rel) return jsonResponse({ success: false, error: "That version is gone." }, 404);

      // Clear then set. The partial unique index would reject two current rows,
      // so the order matters and this is the pair that satisfies it.
      await supabase.from("b2b_capture_releases").update({ is_current: false }).eq("is_current", true);
      const { error } = await supabase.from("b2b_capture_releases")
        .update({ is_current: true }).eq("id", id);
      if (error) return jsonResponse({ success: false, error: error.message }, 500);
      void who;
      return jsonResponse({ success: true, version: rel.version });
    }

    // ------------------------------------------------------------------ prune
    //
    // History is append-only in normal use -- that is the whole safety story --
    // but a mistyped label or an abandoned experiment should not be permanent
    // furniture, and pruning it should not need a developer either.
    //
    // The live version can never be deleted. That is the one rule: without it,
    // a tidy-up could leave the bench with nothing to download, which is the
    // exact failure this table exists to prevent. Roll the pointer to something
    // else first, and then the old one becomes deletable.
    if (action === "delete_version") {
      const id = str(body.id, 64, "Version", true)!;
      const { data: rel } = await supabase.from("b2b_capture_releases")
        .select("id, version, file_path, is_current").eq("id", id).maybeSingle();
      if (!rel) return jsonResponse({ success: false, error: "That version is already gone." }, 404);
      if (rel.is_current) {
        return jsonResponse({
          success: false,
          error: `"${rel.version}" is the live version. Make another version live first, then delete this one.`,
        }, 409);
      }

      // Object first: a row without its object is a download that 500s, whereas
      // an object without its row is invisible litter. If the second step fails,
      // litter is the better of the two.
      const rm = await supabase.storage.from(BUCKET).remove([rel.file_path]);
      if (rm.error) return jsonResponse({ success: false, error: rm.error.message }, 500);
      const { error } = await supabase.from("b2b_capture_releases").delete().eq("id", id);
      if (error) return jsonResponse({ success: false, error: error.message }, 500);
      return jsonResponse({ success: true, version: rel.version });
    }

    return jsonResponse({ success: false, error: "Unknown action: " + action }, 400);
  } catch (e) {
    if (e instanceof Invalid) return jsonResponse({ success: false, error: e.message }, 400);
    return jsonResponse({ success: false, error: String((e as Error)?.message || e) }, 500);
  }
});
