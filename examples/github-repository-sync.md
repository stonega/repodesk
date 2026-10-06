# Automatic GitHub repository updates

Manual staging check; GitHub changes below require an operator's chosen test
repository. Automated tests use fake GitHub responses and disposable databases.

1. Connect a test repository to a workspace. Open **Overview → Manage GitHub**.
   If there are more than five repositories, expand the remaining-count tag.
2. Rename the repository in GitHub, then return to RepoDesk. Its name and external
   link update on focus or the next five-second refresh without closing the
   dialog or collapsing the expanded list.
3. Open **Plugins → Codex**. The configured repository name and the Add/Edit
   repository selector show the new name. Leave a branch/maintainer draft open,
   rename again on GitHub, and return. The selected ID follows the new name;
   branch and maintainer drafts remain intact.
4. If the workspace has a Code Truth target for that repository, its URL follows
   the rename and its configured network branches remain unchanged. Check its
   index status through the existing sync action.
5. Remove App access to the repository on GitHub. On refresh it disappears from
   the connected list and selectors. Granting a different repository with the
   old name must not add it to this workspace. Restoring access still requires
   the existing authorization and selection flow.
6. Simulate a GitHub outage using the test transport. Keep the saved list visible
   with an update notice; recovery clears the notice automatically. Close Manage
   GitHub or hide the tab and confirm repository polling stops. Returning to a
   visible tab refreshes again.

This implementation polls authenticated metadata; it does not register webhooks
or change repository content. Metadata changes advance the connection revision,
so previously pinned runs or pending approval requests may need to be started again.
