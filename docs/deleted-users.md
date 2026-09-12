# Deleted users

Deleting access archives the workspace membership, sets it to disabled, and records
the deletion date. It does not delete the global account or historical events, and
does not change access to other workspaces. Repeated deletion is idempotent.

Web, iPhone and Mac show archived memberships in a separate Deleted Users list.
They are excluded from the main directory and its role/disabled counts. Ordinary
disabled memberships stay in the directory and may be reactivated. Archived
memberships cannot be edited or reactivated through the update-user endpoint.

Migration `000009_deleted_members` backfills older explicit `member.deleted` audit
events only when the membership is still disabled and has no later user-update
event. A disabled membership without that evidence is not assumed deleted.

Deploy the migration and backend before distributing the updated native clients.
Older APIs omit the optional deletion date, so the clients remain compatible, but
separation requires the new server. No named production accounts are changed by
this code update alone unless their existing audit records meet the backfill rule.
