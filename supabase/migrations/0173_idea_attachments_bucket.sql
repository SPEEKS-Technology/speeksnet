-- 0173: idea-attachments bucket for Submit an Idea.
--
-- The idea form used to post straight to formsubmit.co into a hidden iframe,
-- and the popup sat on "Sending..." until that free service answered — several
-- seconds normally, far longer with a phone photo attached, forever if it never
-- answered, and "Idea Submitted!" even when what came back was an error page.
-- It now posts to the idea-submit edge function, which mails through the same
-- Gmail relay as every other report.
--
-- The relay takes to/subject/html only — no attachments — so a file goes here
-- and the email carries a signed link to it. PRIVATE: an idea can carry a
-- screenshot of anything on a store screen, and a public bucket would make every
-- one of them guessable-URL readable forever. Only the service role (the edge
-- function) writes or signs; no policies, same as b2b-custody.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'idea-attachments', 'idea-attachments', false, 10485760,
  array[
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;
