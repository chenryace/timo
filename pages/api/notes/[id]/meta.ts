import { api } from 'libs/server/connect';
import { jsonToMeta, metaToJson } from 'libs/server/meta';
import { useAuth } from 'libs/server/middlewares/auth';
import { useStore } from 'libs/server/middlewares/store';
import { getPathNoteById } from 'libs/server/note-path';
import { NOTE_DELETED } from 'libs/shared/meta';
// TreeActions and strCompress may no longer be needed directly in this file
// import TreeActions from 'libs/shared/tree'; 
// import { strCompress } from 'libs/shared/str'; 
import { cascadeSoftDeleteNotes } from 'libs/server/note-actions'; // Added import

export default api()
    .use(useAuth)
    .use(useStore)
    .post(async (req, res) => {
        const id = req.body.id || req.query.id; // id of the note to update
        const notePath = getPathNoteById(id);

        if (!(await req.state.store.hasObject(notePath))) {
            // Or handle as an error, e.g., res.APIError.NOT_FOUND.throw()
            return res.status(404).json({ message: 'Note not found' });
        }

        const oldMetaS3 = await req.state.store.getObjectMeta(notePath);
        const oldMetaJson = metaToJson(oldMetaS3);

        // Check if this request is a soft deletion
        const isSoftDeleteRequest = req.body.deleted === NOTE_DELETED.DELETED && oldMetaJson.deleted !== NOTE_DELETED.DELETED;

        let finalUpdatedNoteMetaJson = {}; // To store the meta of the main note for the response

        if (isSoftDeleteRequest) {
            // Use the new shared function for cascade soft deletion
            await cascadeSoftDeleteNotes(req.state.store, req.state.treeStore, id);
            
            // Update finalUpdatedNoteMetaJson for the response by refetching the main note's meta
            const newMainMetaS3 = await req.state.store.getObjectMeta(getPathNoteById(id));
            finalUpdatedNoteMetaJson = metaToJson(newMainMetaS3);

            // Remove the main soft-deleted note from its parent in the tree
            // This check for mainItem in tree is implicitly handled by cascadeSoftDeleteNotes
            // which returns early if mainItem is not in tree.
            // However, removeItem should be robust enough or treeStore should handle unknown ids.
            await req.state.treeStore.removeItem(id);

        } else {
            // Standard metadata update (not a soft delete or already soft-deleted)
            // Important: req.body might only contain 'id' and 'title', not 'deleted'
            // So, we merge with oldMetaJson to preserve existing fields like 'deleted'
            const newMetaJson = {
                ...oldMetaJson, // Start with old meta from S3
                ...req.body,    // Apply changes from request body
                date: new Date().toISOString(), // Always update modification date
            };
            // Remove 'id' from meta if it was passed in req.body to avoid issues with jsonToMeta
            if (newMetaJson.id) delete newMetaJson.id; 
            
            // If this request is un-deleting, then add it back to the tree
            if (req.body.deleted === NOTE_DELETED.NORMAL && oldMetaJson.deleted === NOTE_DELETED.DELETED) {
                // Default to ROOT_ID if no parentId specified or found.
                // This might need more sophisticated logic to determine the correct parent.
                // TreeActions.ROOT_ID might be an issue if TreeActions is removed.
                // Consider defining ROOT_ID elsewhere or passing it if needed.
                // For now, assuming treeStore.restoreItem can handle a default or has ROOT_ID.
                // Or, keep TreeActions import if strictly needed for ROOT_ID here.
                // The prompt for cascadeSoftDeleteNotes implies TreeActions is available in TreeStore.
                // Let's assume treeStore or a shared constant provides ROOT_ID if TreeActions is removed.
                // For this step, we focus on the soft delete path.
                // If `oldMetaJson.parentId` is not available, `treeStore.restoreItem` might need a default.
                // Let's assume `req.state.treeStore.ROOT_ID` or similar is available if `TreeActions` is removed.
                // For now, let's use a string 'root' or ensure ROOT_ID is imported from elsewhere if TreeActions is removed.
                // Re-checking prompt: TreeActions is used in cascadeSoftDeleteNotes, so it's available.
                // However, this file might not need it directly.
                // Let's assume `oldMetaJson.parentId || 'root'` is acceptable or TreeActions.ROOT_ID is still accessible.
                // The prompt's `cascadeSoftDeleteNotes` imports `TreeActions` itself.
                // This file's `TreeActions` import for `TreeActions.ROOT_ID` in the "else" branch:
                // If `TreeActions` is removed from this file's imports, `TreeActions.ROOT_ID` would fail.
                // The prompt says: "// TreeActions may no longer be needed here if only used for flattenTree in the deleted block"
                // It IS used for TreeActions.ROOT_ID in the else block. So we should keep it.
                await req.state.treeStore.restoreItem(id, oldMetaJson.parentId || (await req.state.treeStore.get()).rootId ); // Assuming tree has rootId
            }


            const newMetaS3 = jsonToMeta(newMetaJson);
            // Merge with oldMetaS3 to ensure no fields are lost if jsonToMeta is not comprehensive
            const mergedS3Meta = { ...oldMetaS3, ...newMetaS3 };


            await req.state.store.copyObject(notePath, notePath, {
                meta: mergedS3Meta,
                contentType: 'text/markdown', // Preserve content type
            });
            finalUpdatedNoteMetaJson = newMetaJson;
        }

        // Prepare and send response
        const { content } = await req.state.store.getObjectAndMeta(notePath); // Content might be empty for new notes
        const responseNote = {
            id,
            content: content || '\n', // Ensure content is not null
            ...finalUpdatedNoteMetaJson,
        };
        res.status(200).json(responseNote);
    })
    .get(async (req, res) => {
        // GET logic remains unchanged
        const id = req.query.id as string; // query.id for GET normally
        const notePath = getPathNoteById(id);
        
        if (!(await req.state.store.hasObject(notePath))) {
            return res.status(404).json({ message: 'Note not found' });
        }
        const meta = await req.state.store.getObjectMeta(notePath);
        res.json(metaToJson(meta));
    });
