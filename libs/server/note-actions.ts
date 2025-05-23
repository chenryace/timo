import { StoreProvider } from 'libs/server/store';
import TreeStore from 'libs/server/tree'; // Assuming TreeStore is the class from libs/server/tree.ts
import TreeActions, { TreeItemModel } from 'libs/shared/tree';
import { NOTE_DELETED } from 'libs/shared/meta';
import { getPathNoteById } from 'libs/server/note-path';
import { metaToJson, jsonToMeta } from 'libs/server/meta'; // For S3 meta conversion
import { strCompress } from 'libs/shared/str'; // For compressing deletedAt if used

/**
 * Performs a cascaded soft delete on a note and all its descendants.
 * This function updates the metadata of the specified note and all its children
 * in the store to mark them as soft-deleted.
 *
 * @param store The StoreProvider instance for physical data access.
 * @param treeStore The TreeStore instance for accessing tree structure.
 * @param noteId The ID of the primary note to soft delete.
 * @returns Promise<void>
 */
export async function cascadeSoftDeleteNotes(
    store: StoreProvider,
    treeStore: TreeStore,
    noteId: string
): Promise<void> {
    const tree = await treeStore.get();
    const mainItem = tree.items[noteId];
    
    if (!mainItem) {
        console.warn(`[cascadeSoftDeleteNotes] Main item with ID ${noteId} not found in tree. Skipping.`);
        // Optionally, throw an error or handle as per application's requirements
        // For example: throw new Error(`Note with ID ${noteId} not found in tree for soft deletion.`);
        return; 
    }

    const descendantItems = TreeActions.flattenTree(tree, noteId);
    // This version from the prompt includes mainItem and then all descendants, which might include mainItem again if flattenTree returns it.
    // A Set could make it unique: const itemsToSoftDelete = Array.from(new Set([mainItem, ...descendantItems]));
    // However, processing an item twice with the same metadata update is generally harmless.
    const itemsToSoftDelete: TreeItemModel[] = [mainItem, ...descendantItems]; 
    
    const now = new Date().toISOString();
    // const compressedNow = strCompress(now); // Use if deletedAt is compressed

    for (const item of itemsToSoftDelete) {
        if (!item || !item.id) continue;

        const currentItemPath = getPathNoteById(item.id);
        if (await store.hasObject(currentItemPath)) {
            const itemMetaS3 = await store.getObjectMeta(currentItemPath); // Get S3-specific meta
            let itemMetaJson = metaToJson(itemMetaS3 || {}); // Convert to JSON, provide empty object if null

            // Update metadata for soft deletion
            itemMetaJson.deleted = NOTE_DELETED.DELETED;
            // Assuming 'deletedAt' is stored as full ISO string for clarity in PostgreSQL
            // If it needs to be compressed for S3 meta, use compressedNow
            itemMetaJson.deletedAt = now; 
            itemMetaJson.date = now; // Update modification date

            // Convert back to S3 meta format and save
            // Preserve other S3 meta fields by merging with existing itemMetaS3
            const newItemMetaS3 = { ...itemMetaS3, ...jsonToMeta(itemMetaJson) };
            
            const existingContent = await store.getObject(currentItemPath); // Preserve existing content
            await store.putObject(currentItemPath, existingContent || '', {
                 meta: newItemMetaS3,
                 contentType: itemMetaS3?.ContentType || itemMetaS3?.contentType || 'text/markdown' // Preserve content type
            });

        } else {
            console.warn(`[cascadeSoftDeleteNotes] Note object for ID ${item.id} not found at path ${currentItemPath}. Skipping metadata update for this item.`);
        }
    }
}
