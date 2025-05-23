import { api, ApiRequest } from 'libs/server/connect';
import { jsonToMeta } from 'libs/server/meta';
import { useAuth } from 'libs/server/middlewares/auth';
import { useStore } from 'libs/server/middlewares/store';
import { getPathNoteById } from 'libs/server/note-path';
import { NOTE_DELETED } from 'libs/shared/meta';
import { ROOT_ID } from 'libs/shared/tree';
import TreeActions from 'libs/shared/tree'; // Still needed for hard delete
import { strCompress } from 'libs/shared/str'; // May not be needed if cascadeSoftDeleteNotes handles compression
import { cascadeSoftDeleteNotes } from 'libs/server/note-actions'; // Added import

export default api()
    .use(useAuth)
    .use(useStore)
    .post(async (req, res) => {
        const { action, data } = req.body as {
            action: 'delete' | 'restore';
            data: {
                id: string;
                parentId?: string;
                permanent?: boolean; // Added permanent flag
            };
        };

        switch (action) {
            case 'delete':
                await deleteNote(req, data.id, data.permanent);
                break;

            case 'restore':
                await restoreNote(req, data.id, data.parentId);
                break;

            default:
                return res.APIError.NOT_SUPPORTED.throw('action not found');
        }

        res.status(204).end();
    });

async function deleteNote(req: ApiRequest, id: string, permanent?: boolean) {
    // const notePath = getPathNoteById(id); // No longer solely needed here for soft delete meta

    // Perform existence check before, or ensure cascadeSoftDeleteNotes handles it.
    // This check is as per the prompt for this file.
    if (!(await req.state.store.hasObject(getPathNoteById(id)))) {
        // This API might be called for already tree-removed items, so a 404 might be too strong.
        // Consider if specific error handling is needed if the note object is gone but was expected.
        // For now, let cascadeSoftDeleteNotes handle the non-existence of the main item if it does.
        // If cascadeSoftDeleteNotes throws, it will be caught by global error handler.
        console.warn(`[trash.ts > deleteNote] Note with ID ${id} not found in store. Proceeding with tree removal if applicable.`);
        // If cascadeSoftDeleteNotes handles non-existent main item by returning (as it does),
        // we might still want to proceed to treeStore.removeItem if the item was only in the tree.
        // However, if the object doesn't exist, it's unlikely to be meaningfully in the tree unless there's a desync.
        // The current cascadeSoftDeleteNotes returns if mainItem is not in tree.items.
        // If mainItem is not in store but IS in tree, cascadeSoftDeleteNotes will process it (and find no S3 object).
    }

    if (permanent) {
        // Hard delete logic (remains as per step 1)
        const tree = await req.state.treeStore.get(); // Still need tree for hard delete
        const descendants = TreeActions.flattenTree(tree, id); 
        
        for (const item of descendants) {
            const currentNotePath = getPathNoteById(item.id);
            if (await req.state.store.hasObject(currentNotePath)) {
                await req.state.store.deleteObject(currentNotePath); 
            }
        }
        await req.state.treeStore.deleteItem(id);
    } else {
        // Soft delete - Use the new shared function
        await cascadeSoftDeleteNotes(req.state.store, req.state.treeStore, id);
        // Then, remove the original (root) item of this soft deletion from its parent in the tree
        await req.state.treeStore.removeItem(id);
    }
}

async function restoreNote(req: ApiRequest, id: string, parentId = ROOT_ID) {
    const notePath = getPathNoteById(id);
    const oldMeta = await req.state.store.getObjectMeta(notePath);
    let meta = jsonToMeta({
        date: new Date().toISOString(),
        deleted: NOTE_DELETED.NORMAL.toString(),
    });
    if (oldMeta) {
        meta = { ...oldMeta, ...meta };
    }

    await req.state.store.copyObject(notePath, notePath, {
        meta,
        contentType: 'text/markdown',
    });
    await req.state.treeStore.restoreItem(id, parentId);
}
