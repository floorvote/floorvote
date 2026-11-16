-- Newly found bills in the email digest depend only on a person's own new-match switch now (#1035).
--
-- Until now the digest went only to people whose digest switch (email_digest_enabled) was on, and it gave an admin
-- or owner the new-match section whatever email_digest_matches_enabled said. A member got it when their own switch
-- was on. The switch is offered to every role from here on and no longer waits on the digest switch, so it is set to
-- whether the person gets the section today. Nobody's newly found bills change. A person with the digest switch off
-- who follows a view starts getting that view, as #1035 intends.
--
-- A person with the digest switch off gets no new matches today, so their switch goes off.
UPDATE users SET email_digest_matches_enabled = 0 WHERE email_digest_enabled = 0;

-- An admin or owner with the digest switch on gets every new match today, so their switch goes on.
-- A member with the digest switch on keeps their own value. saved_view_subscriptions is left alone.
UPDATE users SET email_digest_matches_enabled = 1 WHERE email_digest_enabled = 1 AND role IN ('admin', 'owner');
