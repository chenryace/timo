import { api } from 'libs/server/connect';
import { metaToJson } from 'libs/server/meta';
import { useAuth } from 'libs/server/middlewares/auth';
import { useStore } from 'libs/server/middlewares/store';
import { getPathNoteById } from 'libs/server/note-path';
import { NoteModel } from 'libs/shared/note';
import { StoreProvider } from 'libs/server/store';
import { API } from 'libs/server/middlewares/error';
import { strCompress } from 'libs/shared/str';
import { ROOT_ID } from 'libs/shared/tree';
import TreeActions from 'libs/shared/tree'; // TreeActions is still used for hard delete
import { cascadeSoftDeleteNotes } from 'libs/server/note-actions'; // Added import

export async function getNote(
    store: StoreProvider,
    id: string
): Promise<NoteModel> {
    const { content, meta } = await store.getObjectAndMeta(getPathNoteById(id));

    if (!content && !meta) {
        throw API.NOT_FOUND.throw();
    }

    const jsonMeta = metaToJson(meta);

    return {
        id,
        content: content || '\n',
        ...jsonMeta,
    } as NoteModel;
}

export default api()
    .use(useAuth)
    .use(useStore)
    .delete(async (req, res) => {
        const id = req.query.id as string;
        // const notePath = getPathNoteById(id); // No longer solely needed here for soft delete meta
        const permanent = req.query.permanent === 'true';

        // Note existence check should ideally be part of cascadeSoftDeleteNotes or done before if preferred
        // For now, let's assume cascadeSoftDeleteNotes handles non-existent main item gracefully or throws.
        // Or, perform a check before calling it:
        if (!(await req.state.store.hasObject(getPathNoteById(id)))) {
             throw API.NOT_FOUND.throw(`Note with id ${id} not found`);
        }

        if (permanent) {
            // Hard delete logic (remains as per step 1)
            const tree = await req.state.treeStore.get(); // Still need tree for hard delete
            const descendantsForHardDelete = TreeActions.flattenTree(tree, id);
            for (const item of descendantsForHardDelete) {
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

        res.status(204).end();
    })
    .get(async (req, res) => {
        const id = req.query.id as string;

        if (id === ROOT_ID) {
            return res.json({
                id,
            });
        }

        const note = await getNote(req.state.store, id);

        res.json(note);
    })
    .post(async (req, res) => {
        const id = req.query.id as string;
        const { content } = req.body;
        const notePath = getPathNoteById(id);
        const oldMeta = await req.state.store.getObjectMeta(notePath);

        if (oldMeta) {
            oldMeta['date'] = strCompress(new Date().toISOString());
        }

        // Empty content may be a misoperation
        if (!content || content.trim() === '\\') {
            await req.state.store.copyObject(notePath, notePath + '.bak', {
                meta: oldMeta,
                contentType: 'text/markdown',
            });
        }

        await req.state.store.putObject(notePath, content, {
            contentType: 'text/markdown',
            meta: oldMeta,
        });

        // 获取更新后的完整笔记数据并返回
        const updatedNote = await getNote(req.state.store, id);
        res.status(200).json(updatedNote);
    });
