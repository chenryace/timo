import { api, ApiRequest } from 'libs/server/connect';
import { jsonToMeta } from 'libs/server/meta';
import { useAuth } from 'libs/server/middlewares/auth';
import { useStore } from 'libs/server/middlewares/store';
import { getPathNoteById } from 'libs/server/note-path';
import { NOTE_DELETED } from 'libs/shared/meta';
import { ROOT_ID } from 'libs/shared/tree';
import TreeActions from 'libs/shared/tree'; // Added import
import { strCompress } from 'libs/shared/str';

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
    const notePath = getPathNoteById(id);

    if (permanent) {
        // Hard delete - deep
        const tree = await req.state.treeStore.get();
        const descendants = TreeActions.flattenTree(tree, id); // Includes the note 'id' itself
        
        for (const item of descendants) {
            const currentNotePath = getPathNoteById(item.id);
            await req.state.store.deleteObject(currentNotePath); // Hard delete current note
        }
    } else {
        // Soft delete
        const noteData = await req.state.store.getObjectAndMeta(notePath);
        const updatedMeta = noteData.meta ? { ...noteData.meta } : {};
        const now = new Date().toISOString();
        updatedMeta['deletedAt'] = strCompress(now); 
        updatedMeta['date'] = strCompress(now);

        await req.state.store.putObject(
            notePath,
            noteData.content || '',
            {
                meta: updatedMeta,
                contentType: noteData.contentType || 'text/markdown',
            }
        );
    }
    // Update the tree cache; this is called for both soft and hard delete
    await req.state.treeStore.removeItem(id);
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
