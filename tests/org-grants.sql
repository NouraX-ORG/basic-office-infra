-- Every cross-organisation grant of the test accounts (docs/teams.md "The test"): something one
-- person gave, handed over or named to someone of another organisation, as the apps store it.
-- tests/privacy-apps.sh reads it before, during and after its checks, undoes what it finds and
-- checks at the end that nothing is left. Read only; run on the server:
--   sudo docker compose exec -T db psql -U nextcloud -d nextcloud -AtX -F "<tab>" -v ON_ERROR_STOP=1 -f - < tests/org-grants.sql
--
-- "Test accounts" are the QA accounts of this test (qa-t6b-<n>) and the owner's demo accounts
-- (demo-*). Two people "meet" as nourax_api's OrgPrivacy rule says: the same account, the service
-- account nourax-teams, or a group in common other than the excluded ones (core
-- shareapi_only_share_with_group_members_exclude_group_list, here ["admin"]). A group share is
-- fine only when the sharer is in the group. Run it while the QA people are in their organisations
-- (privacy-apps.sh puts them there first): a QA account left in no group meets nobody.
--
-- One line per grant, tab-separated, no field empty ("-"):
--   order  kind  undo-by  a  b  c  who  what
-- order 0 is a hand-over (undo those first: the shares of the object are then read again), 1 a
-- share or rule, 2 a notification. undo-by is the QA account that can undo it through the app's own
-- API, "root" for a hand-over undone on the server (occ, or the column the app itself writes), or
-- "-" when it is not the test's own (a demo or other account: reported, never changed).
-- SPDX-License-Identifier: AGPL-3.0-or-later

create function pg_temp.tested(u text) returns boolean language sql immutable
	as $$ select coalesce(u, '') ~ '^(qa-t6b-[0-9]+|demo-[a-z0-9-]+)$' $$;
create function pg_temp.qa(u text) returns text language sql immutable
	as $$ select case when coalesce(u, '') ~ '^qa-t6b-[0-9]+$' then u else '-' end $$;
create function pg_temp.excluded() returns setof text language sql stable as $$
	select json_array_elements_text(coalesce(nullif((select configvalue from oc_appconfig where appid = 'core'
		and configkey = 'shareapi_only_share_with_group_members_exclude_group_list'), ''), '[]')::json) $$;
create function pg_temp.meets(a text, b text) returns boolean language sql stable as $$
	select a = b or a = 'nourax-teams' or b = 'nourax-teams' or exists (select 1 from oc_group_user x
		join oc_group_user y on y.gid = x.gid where x.uid = a and y.uid = b
		and x.gid not in (select pg_temp.excluded())) $$;
create function pg_temp.member(u text, g text) returns boolean language sql stable as $$
	select u = 'nourax-teams' or (g not in (select pg_temp.excluded())
		and exists (select 1 from oc_group_user where uid = u and gid = g)) $$;
-- Group ids in DAV principal addresses are url-encoded (org%3A...).
create function pg_temp.undav(p text) returns text language sql immutable
	as $$ select replace(replace(regexp_replace(p, '^principals/(users|groups)/', ''), '%3A', ':'), '%3a', ':') $$;

-- NoBoard boards handed to someone of another organisation: a card on it was made by a QA account
-- the owner does not meet, or it is one of the test's own boards ("QA t6b ...", always made by
-- qa-t6b-4) that another organisation's QA account now owns. Undone with Deck's own occ command
-- (deck:transfer-ownership --remap), as the app's API refuses the way back across organisations.
select distinct on (b.id) 0, 'board-owner', 'root', b.id, b.owner, x.maker, b.owner,
	format('NoBoard board %s "%s" of %s is owned by %s', b.id, b.title, x.maker, b.owner)
from oc_deck_boards b
cross join lateral (
	select c.owner as maker from oc_deck_stacks s join oc_deck_cards c on c.stack_id = s.id
	where s.board_id = b.id and pg_temp.qa(c.owner) <> '-' and not pg_temp.meets(b.owner, c.owner)
	union all
	select 'qa-t6b-4' where b.title like 'QA t6b%' and not pg_temp.meets(b.owner, 'qa-t6b-4')
) x
where pg_temp.qa(b.owner) <> '-'
order by b.id;

-- The test's own forms ("QA t6b ...", always made by qa-t6b-4) that another organisation's QA
-- account now owns. Undone by writing the owner back the way NoForms' own owner change does
-- (ApiController::updateForm sets owner_id and nothing else).
select 0, 'form-owner', 'root', f.id, f.owner_id, 'qa-t6b-4', f.owner_id,
	format('NoForms form %s "%s" of qa-t6b-4 is owned by %s', f.id, f.title, f.owner_id)
from oc_forms_v2_forms f
where f.title like 'QA t6b%' and pg_temp.qa(f.owner_id) <> '-' and not pg_temp.meets(f.owner_id, 'qa-t6b-4');

-- NoBoard board shares (type 0 person, 1 group, 7 team).
select 1, 'board-share', pg_temp.qa(b.owner), a.board_id, a.id, a.type, a.participant,
	format('NoBoard board %s "%s" of %s is shared with %s', a.board_id, b.title, b.owner, a.participant)
from oc_deck_board_acl a join oc_deck_boards b on b.id = a.board_id
where (a.type = 0 and (pg_temp.tested(b.owner) or pg_temp.tested(a.participant)) and not pg_temp.meets(b.owner, a.participant))
	or (a.type = 1 and pg_temp.tested(b.owner) and not pg_temp.member(b.owner, a.participant))
	or (a.type not in (0, 1) and pg_temp.tested(b.owner));

-- NoBoard card people (type 0 person, 1 group).
select 1, 'card-person', pg_temp.qa(b.owner), b.id || '/' || s.id || '/' || c.id, u.type, u.participant, u.participant,
	format('NoBoard card %s on board %s of %s is assigned to %s', c.id, b.id, b.owner, u.participant)
from oc_deck_assigned_users u join oc_deck_cards c on c.id = u.card_id
	join oc_deck_stacks s on s.id = c.stack_id join oc_deck_boards b on b.id = s.board_id
where (u.type = 0 and (pg_temp.tested(b.owner) or pg_temp.tested(u.participant)) and not pg_temp.meets(b.owner, u.participant))
	or (u.type <> 0 and pg_temp.tested(b.owner) and not pg_temp.member(b.owner, u.participant));

-- NoGantt project shares (user, group, team).
select 1, 'gantt-share', pg_temp.qa(p.owner_id), s.id, p.id, s.principal_type, s.principal_id,
	format('NoGantt project %s "%s" of %s is shared with %s %s', p.id, p.title, p.owner_id, s.principal_type, s.principal_id)
from oc_nc_gantt_shares s join oc_nc_gantt_projects p on p.id = s.project_id
where (s.principal_type = 'user' and (pg_temp.tested(p.owner_id) or pg_temp.tested(s.principal_id)) and not pg_temp.meets(p.owner_id, s.principal_id))
	or (s.principal_type = 'group' and pg_temp.tested(p.owner_id) and not pg_temp.member(p.owner_id, s.principal_id))
	or (s.principal_type not in ('user', 'group') and pg_temp.tested(p.owner_id));

-- NoGantt planning people (a resource that stands for an account).
select 1, 'gantt-resource', pg_temp.qa(r.owner_id), r.id, '-', '-', r.uid,
	format('NoGantt resource %s "%s" of %s stands for %s', r.id, r.name, r.owner_id, r.uid)
from oc_nc_gantt_resources r
where coalesce(r.uid, '') <> '' and (pg_temp.tested(r.owner_id) or pg_temp.tested(r.uid)) and not pg_temp.meets(r.owner_id, r.uid);

-- NoForms shares (0 person, 1 group, 7 team; 3 is a link).
select 1, 'form-share', pg_temp.qa(f.owner_id), s.form_id, s.id, s.share_type, s.share_with,
	format('NoForms form %s "%s" of %s is shared with %s', s.form_id, f.title, f.owner_id, s.share_with)
from oc_forms_v2_shares s join oc_forms_v2_forms f on f.id = s.form_id
where (s.share_type = 0 and (pg_temp.tested(f.owner_id) or pg_temp.tested(s.share_with)) and not pg_temp.meets(f.owner_id, s.share_with))
	or (s.share_type = 1 and pg_temp.tested(f.owner_id) and not pg_temp.member(f.owner_id, s.share_with))
	or (s.share_type = 7 and pg_temp.tested(f.owner_id));

-- Photos album collaborators (0 person, 1 group; 3 is a link).
select 1, 'album-person', pg_temp.qa(a."user"), a.album_id, c.collaborator_type, a.name, c.collaborator_id,
	format('Photos album %s "%s" of %s has the collaborator %s', a.album_id, a.name, a."user", c.collaborator_id)
from oc_photos_albums_collabs c join oc_photos_albums a on a.album_id = c.album_id
where (c.collaborator_type = 0 and (pg_temp.tested(a."user") or pg_temp.tested(c.collaborator_id)) and not pg_temp.meets(a."user", c.collaborator_id))
	or (c.collaborator_type = 1 and pg_temp.tested(a."user") and not pg_temp.member(a."user", c.collaborator_id));

-- Team folder rules (a lead's advanced permissions) for a person who meets nobody of the folder's
-- groups, or a group none of them is in. Undone by qa-t6b-4, the lead of the QA team folder.
select 1, 'folder-rule', case when exists (select 1 from oc_group_folders_groups g where g.folder_id = gf.folder_id
		and g.group_id = 'team:qa-t6b-team-a1') then 'qa-t6b-4' else '-' end,
	acl.acl_id, gf.mount_point, regexp_replace(fc.path, '^files/', ''), acl.mapping_type || ':' || acl.mapping_id,
	format('Team folder "%s", folder "%s" has a rule for %s %s', gf.mount_point, regexp_replace(fc.path, '^files/', ''), acl.mapping_type, acl.mapping_id)
from oc_group_folders_acl acl join oc_filecache fc on fc.fileid = acl.fileid
	join oc_group_folders gf on gf.storage_id = fc.storage
where (pg_temp.tested(acl.mapping_id) or exists (select 1 from oc_group_folders_groups g where g.folder_id = gf.folder_id
		and g.group_id ~ '^(org|team):(qa-t6b-|demo-)'))
	and ((acl.mapping_type = 'user' and not exists (select 1 from oc_group_folders_groups g
			join oc_group_user m on m.gid = g.group_id where g.folder_id = gf.folder_id and pg_temp.meets(m.uid, acl.mapping_id)))
		or (acl.mapping_type = 'group' and not exists (select 1 from oc_group_folders_groups g
			join oc_group_user m on m.gid = g.group_id where g.folder_id = gf.folder_id and pg_temp.member(m.uid, acl.mapping_id)))
		or acl.mapping_type not in ('user', 'group'));

-- NoDrive: asking someone to take over one's files. Undone by the person asked (they turn it down).
select 1, 'file-transfer', pg_temp.qa(t.target_user), t.id, t.source_user, '-', t.target_user,
	format('%s asked %s to take over "%s" (request %s)', t.source_user, t.target_user, t.node_name, t.id)
from oc_user_transfer_owner t
where (pg_temp.tested(t.source_user) or pg_temp.tested(t.target_user)) and not pg_temp.meets(t.source_user, t.target_user);

-- NoDrive shares with a person or a group.
select 1, 'file-share', pg_temp.qa(s.uid_initiator), s.id, '-', '-', s.share_with,
	format('NoDrive share %s of "%s" by %s with %s', s.id, s.file_target, s.uid_initiator, s.share_with)
from oc_share s
where (s.share_type = 0 and (pg_temp.tested(s.uid_initiator) or pg_temp.tested(s.uid_owner) or pg_temp.tested(s.share_with))
		and (not pg_temp.meets(s.uid_initiator, s.share_with) or not pg_temp.meets(s.uid_owner, s.share_with)))
	or (s.share_type = 1 and pg_temp.tested(s.uid_initiator) and not pg_temp.member(s.uid_initiator, s.share_with));

-- Calendars (and task lists) and address books shared over CalDAV or CardDAV.
select 1, 'dav-share', pg_temp.qa(pg_temp.undav(r.principaluri)), d.id, d.type, r.uri, d.principaluri,
	format('The %s "%s" of %s is shared with %s', d.type, r.uri, pg_temp.undav(r.principaluri), pg_temp.undav(d.principaluri))
from oc_dav_shares d
	join (select 'calendar'::text as type, id, principaluri, uri from oc_calendars
		union all select 'addressbook', id, principaluri, uri from oc_addressbooks) r on r.type = d.type and r.id = d.resourceid
where r.principaluri like 'principals/users/%'
	and ((d.principaluri like 'principals/users/%' and (pg_temp.tested(pg_temp.undav(r.principaluri)) or pg_temp.tested(pg_temp.undav(d.principaluri)))
			and not pg_temp.meets(pg_temp.undav(r.principaluri), pg_temp.undav(d.principaluri)))
		or (d.principaluri like 'principals/groups/%' and pg_temp.tested(pg_temp.undav(r.principaluri))
			and not pg_temp.member(pg_temp.undav(r.principaluri), pg_temp.undav(d.principaluri))));

-- Out of office: the replacement named while away.
select 1, 'replacement', pg_temp.qa(a.user_id), a.id, '-', '-', a.replacement_user_id,
	format('%s names %s as replacement while away', a.user_id, a.replacement_user_id)
from oc_dav_absence a
where coalesce(a.replacement_user_id, '') <> '' and (pg_temp.tested(a.user_id) or pg_temp.tested(a.replacement_user_id))
	and not pg_temp.meets(a.user_id, a.replacement_user_id);

-- Notifications that name a test account of another organisation (share and hand-over notices).
-- Undone by the person notified: they dismiss it.
select 2, 'notification', pg_temp.qa(n."user"), n.notification_id, n.app, n.subject, p.uid,
	format('%s has a notification (%s, %s) naming %s', n."user", n.app, n.subject, p.uid)
from oc_notifications n
	join (select user_id as uid from oc_user_oidc union select uid from oc_users) p
		on pg_temp.tested(p.uid) and p.uid <> n."user"
		and (position('"' || p.uid || '"' in coalesce(n.subject_parameters, '')) > 0
			or position('"' || p.uid || '"' in coalesce(n.message_parameters, '')) > 0)
where pg_temp.tested(n."user") and not pg_temp.meets(n."user", p.uid);
