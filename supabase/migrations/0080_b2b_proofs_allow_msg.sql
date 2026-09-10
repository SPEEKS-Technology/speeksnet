-- ============================================================
-- b2b-proofs: actually allow the .msg files the feature is built around
--
-- THE BUG, reported by Nick 2026-09-10 after installing classic Outlook:
--
--     Couldn't attach that message: mime type application/vnd.ms-outlook
--     is not supported
--
-- The bucket's allowed_mime_types were:
--   image/png, image/jpeg, image/webp, application/pdf, message/rfc822, text/plain
--
-- So a saved .eml (message/rfc822) uploaded fine and an Outlook .msg
-- (application/vnd.ms-outlook) was refused BY STORAGE, after passing every check
-- in the edge function and the browser. Which is why it presented as a mystery:
-- the client-side rules, the drop routes and the MIME inference were all correct
-- and had all been fixed several times over, and the failure was one row of
-- configuration two layers further down.
--
-- It has been broken since 2026-09-08, when .msg became the sanctioned format
-- (0050's kinds were narrowed to 'email' and PROOF_MIMES in b2b-deals was cut to
-- the two mail types). The comment above PROOF_MIMES says it "mirrors the
-- b2b-proofs bucket's allowlist" -- it did not, and nothing checked.
--
-- WHY THE LIST IS NARROWED AS WELL AS EXTENDED:
-- the only creatable proof is the client's email, so the bucket now permits
-- exactly the two things that can be uploaded. Everything else was left over
-- from the screenshot/document/note era. This governs NEW uploads only; the
-- files already in the bucket are untouched and still download, which is what
-- keeps the historical rows readable.
--
-- 6MB is the real ceiling and it lives in the edge function (PROOF_MAX_BYTES),
-- because the base64 has to survive a JSON request body on the way in. The
-- bucket's 10MB stays as the outer guard rather than being tightened to match --
-- two limits that must agree is a worse arrangement than one that is merely
-- generous.
-- ============================================================

update storage.buckets
   set allowed_mime_types = array['message/rfc822', 'application/vnd.ms-outlook']
 where id = 'b2b-proofs';
