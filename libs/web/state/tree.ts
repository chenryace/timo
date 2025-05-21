import { cloneDeep, forEach, map, reduce, isEmpty } from 'lodash';
import { genId } from 'libs/shared/id';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createContainer } from 'unstated-next';
import TreeActions, {
    DEFAULT_TREE,
    MovePosition,
    ROOT_ID,
    TreeItemModel,
    TreeModel,
} from 'libs/shared/tree';
import useNoteAPI from '../api/note';
import noteCache from '../cache/note';
import useTreeAPI from '../api/tree';
import { NOTE_DELETED, NOTE_PINNED } from 'libs/shared/meta';
import { NoteModel } from 'libs/shared/note';
import { useToast } from '../hooks/use-toast';
import { uiCache } from '../cache';

const TREE_CACHE_KEY = 'tree';

const findParentTreeItems = (tree: TreeModel, note: NoteModel) => {
    const parents = [] as TreeItemModel[];

    let tempNote = note;
    while (tempNote.pid && tempNote.pid !== ROOT_ID) {
        const curData = tree.items[tempNote.pid];
        if (curData?.data) {
            tempNote = curData.data;
            parents.push(curData);
        } else {
            break;
        }
    }

    return parents;
};

const useNoteTree = (initData: TreeModel = DEFAULT_TREE) => {
    const { mutate, loading, fetch: fetchTree } = useTreeAPI();
    const [tree, setTree] = useState<TreeModel>(initData);
    const [initLoaded, setInitLoaded] = useState<boolean>(false);
    const { fetch: fetchNote } = useNoteAPI();
    const treeRef = useRef(tree);
    const toast = useToast();

    useEffect(() => {
        treeRef.current = tree;
    }, [tree]);

    const fetchNotes = useCallback(
        async (inputTree: TreeModel): Promise<TreeModel> => {
            const noteDataMap: Record<string, NoteModel | undefined> = {};
            const itemIds = Object.keys(inputTree.items);

            await Promise.all(
                itemIds.map(async (id) => {
                    if (id === ROOT_ID && !inputTree.items[ROOT_ID]?.data) {
                        return; // ROOT_ID might not have/need data
                    }
                    try {
                        const note = await fetchNote(id);
                        if (note) {
                            noteDataMap[id] = note;
                        } else {
                            console.warn(`[fetchNotes] Note data for ID ${id} not found or fetch failed. This item will be excluded from the hydrated tree.`);
                        }
                    } catch (error) {
                        console.error(`[fetchNotes] Error fetching note for ID ${id}:`, error);
                    }
                })
            );

            const newValidItems: Record<string, TreeItemModel> = {};
            for (const itemId of itemIds) {
                const originalItem = inputTree.items[itemId];
                const fetchedData = noteDataMap[itemId];

                if (fetchedData) {
                    newValidItems[itemId] = {
                        ...originalItem,
                        data: fetchedData,
                    };
                } else if (itemId === ROOT_ID) { // Always include ROOT_ID
                    newValidItems[itemId] = {
                        ...originalItem,
                        data: undefined, // Explicitly set if no data was fetched/expected
                    };
                }
            }

            for (const itemId in newValidItems) {
                const item = newValidItems[itemId];
                if (item.children && Array.isArray(item.children)) {
                    item.children = item.children.filter(childId => newValidItems[childId] !== undefined);
                }
            }

            return {
                ...inputTree,
                items: newValidItems,
            };
        },
        [fetchNote]
    );

    const initTree = useCallback(async () => {
        setInitLoaded(false);
        let treeToSet: TreeModel | null = null;

        const cachedTreeStructure = await uiCache.getItem<TreeModel>(TREE_CACHE_KEY);
        if (cachedTreeStructure) {
            console.log("[initTree] Cache hit. Cleaning and hydrating cached tree structure with notes...");
            try {
                const cleanedCachedTree = TreeActions.cleanTreeModel(cachedTreeStructure);
                if (!cleanedCachedTree.items[ROOT_ID]) {
                    console.warn("[initTree] Cached tree structure invalid after cleaning (ROOT_ID missing). Removing cache.");
                    await uiCache.removeItem(TREE_CACHE_KEY);
                } else {
                    const hydratedCache = await fetchNotes(cleanedCachedTree);
                    if (hydratedCache && hydratedCache.items[ROOT_ID]) {
                        treeToSet = hydratedCache;
                        console.log("[initTree] Successfully hydrated tree from cache.");
                    } else {
                        console.warn("[initTree] Cached tree structure became invalid after hydration. Will fetch from server.");
                        await uiCache.removeItem(TREE_CACHE_KEY);
                    }
                }
            } catch (error) {
                console.error("[initTree] Error cleaning or hydrating cached tree:", error);
                await uiCache.removeItem(TREE_CACHE_KEY); // Remove potentially corrupted cache
            }
        } else {
            console.log("[initTree] Cache miss.");
        }

        if (!treeToSet) {
            console.log("[initTree] Fetching tree structure from server...");
            const serverTreeStructure = await fetchTree();

            if (serverTreeStructure) {
                console.log("[initTree] Server tree structure fetched. Cleaning and hydrating with notes...");
                try {
                    const cleanedServerTree = TreeActions.cleanTreeModel(serverTreeStructure);
                    if (!cleanedServerTree.items[ROOT_ID]) {
                        console.error("[initTree] Server tree structure invalid after cleaning (ROOT_ID missing).");
                        toast('Failed to load tree: Invalid structure from server.', 'error');
                    } else {
                        const hydratedServerTree = await fetchNotes(cleanedServerTree);
                        if (hydratedServerTree && hydratedServerTree.items[ROOT_ID]) {
                            treeToSet = hydratedServerTree;
                            console.log("[initTree] Successfully hydrated tree from server.");
                            // Save the cleaned structure, not the raw one, if it was successfully hydrated
                            await uiCache.setItem(TREE_CACHE_KEY, cleanedServerTree);
                        } else {
                            console.error("[initTree] Server tree structure became invalid after hydration.");
                            toast('Failed to initialize tree: server data inconsistency.', 'error');
                        }
                    }
                } catch (error) {
                    console.error("[initTree] Error cleaning or hydrating server tree:", error);
                    toast('Failed to load notes for the tree.', 'error');
                }
            } else {
                console.error("[initTree] Failed to fetch valid tree structure from server or ROOT_ID missing.");
                if (serverTreeStructure) {
                     toast('Failed to load tree: Invalid structure from server.', 'error');
                } else {
                     toast('Failed to load tree: Could not connect to server.', 'error');
                }
            }
        }

        if (treeToSet) {
            setTree(treeToSet);
        } else {
            console.warn("[initTree] Tree initialization failed from all sources. Falling back to default tree.");
            setTree(DEFAULT_TREE);
        }
        setInitLoaded(true);
    }, [fetchNotes, fetchTree, toast, DEFAULT_TREE]);

    const addItem = useCallback((item: NoteModel) => {
        console.log('添加笔记到树结构', item);
        // 确保父ID存在，如果不存在则使用ROOT_ID
        const parentId = item.pid && treeRef.current.items[item.pid] ? item.pid : ROOT_ID;
        
        // 添加项目到树结构
        let tree = TreeActions.addItem(treeRef.current, item.id, parentId);
        
        // 确保设置完整的节点属性
        tree.items[item.id] = {
            ...tree.items[item.id],
            id: item.id,
            data: item,
            hasChildren: tree.items[item.id].children.length > 0,
            isExpanded: false
        };
        
        console.log('笔记已添加到树结构，依赖 addItem 更新', tree.items[item.id]);
        setTree({...tree}); // 使用新对象触发重新渲染
    }, []);

    const removeItem = useCallback(async (id: string) => {
        const tree = TreeActions.removeItem(treeRef.current, id);

        setTree(tree);
        await Promise.all(
            map(
                TreeActions.flattenTree(tree, id),
                async (item) =>
                    await noteCache.mutateItem(item.id, {
                        deleted: NOTE_DELETED.DELETED,
                    })
            )
        );
    }, []);

    const genNewId = useCallback(() => {
        let newId = genId();
        while (treeRef.current.items[newId]) {
            newId = genId();
        }
        return newId;
    }, []);

    const moveItem = useCallback(
        async (data: { source: MovePosition; destination: MovePosition }) => {
            setTree(
                TreeActions.moveItem(
                    treeRef.current,
                    data.source,
                    data.destination
                )
            );
            await mutate({
                action: 'move',
                data,
            });
        },
        [mutate]
    );

    const mutateItem = useCallback(
        async (id: string, data: Partial<TreeItemModel>) => {
            // Optimistic update of local state
            setTree(currentTree => TreeActions.mutateItem(currentTree, id, data));

            // Prepare payload for API: create a copy and remove the 'data' property (NoteModel)
            const apiDataPayload = { ...data };
            delete apiDataPayload.data;

            // @todo diff 没有变化就不发送请求
            // Send API request only if there are other changes besides the NoteModel data
            if (!isEmpty(apiDataPayload)) {
                await mutate({
                    action: 'mutate',
                    data: {
                        ...apiDataPayload,
                        id,
                    },
                });
            }
        },
        [mutate, setTree]
    );

    const restoreItem = useCallback(async (id: string, pid: string) => {
        let itemsToUpdateInCache: TreeItem[] = [];
        setTree(currentTree => {
            const newTree = TreeActions.restoreItem(currentTree, id, pid);
            // Capture items from the newTree for cache update after state is set
            itemsToUpdateInCache = TreeActions.flattenTree(newTree, id);
            return newTree;
        });

        // This Promise.all should ideally run after setTree has flushed and tree state is updated.
        // For now, we assume itemsToUpdateInCache is correctly populated from the newTree structure.
        await Promise.all(
            map(
                itemsToUpdateInCache, // Use the captured list
                async (item) =>
                    await noteCache.mutateItem(item.id, {
                        deleted: NOTE_DELETED.NORMAL,
                    })
            )
        );
    }, [setTree, noteCache]); // Added setTree and noteCache to dependencies

    const deleteItem = useCallback((id: string) => { // No longer async if only calling setTree
        setTree(currentTree => TreeActions.deleteItem(currentTree, id));
    }, [setTree]); // Added setTree to dependencies

    const getPaths = useCallback((note: NoteModel) => {
        const tree = treeRef.current;
        return findParentTreeItems(tree, note).map(
            (listItem) => listItem.data!
        );
    }, []);

    const setItemsExpandState = useCallback(
        async (items: TreeItemModel[], newValue: boolean) => {
            const newTree = reduce(
                items,
                (tempTree, item) =>
                    TreeActions.mutateItem(tempTree, item.id, {
                        isExpanded: newValue,
                    }),
                treeRef.current
            );
            setTree(newTree);

            for (const item of items) {
                await mutate({
                    action: 'mutate',
                    data: {
                        isExpanded: newValue,
                        id: item.id,
                    },
                });
            }
        },
        [mutate]
    );

    const showItem = useCallback(
        (note: NoteModel) => {
            const parents = findParentTreeItems(treeRef.current, note);
            setItemsExpandState(parents, true)
                ?.catch((v) => console.error('Error whilst expanding item: %O', v));
        },
        [setItemsExpandState]
    );

    const checkItemIsShown = useCallback((note: NoteModel) => {
        const parents = findParentTreeItems(treeRef.current, note);
        return reduce(
            parents,
            (value, item) => value && !!item.isExpanded,
            true
        );
    }, []);

    const collapseAllItems = useCallback(() => {
        const expandedItems = TreeActions.flattenTree(treeRef.current).filter(
            (item) => item.isExpanded
        );
        setItemsExpandState(expandedItems, false)
            .catch((v) => console.error('Error whilst collapsing item: %O', v));
    }, [setItemsExpandState]);

    const pinnedTree = useMemo(() => {
        const items = cloneDeep(tree.items);
        const pinnedIds: string[] = [];
        forEach(items, (item) => {
            if (
                item.data?.pinned === NOTE_PINNED.PINNED &&
                item.data.deleted !== NOTE_DELETED.DELETED
            ) {
                pinnedIds.push(item.id);
            }
        });

        items[ROOT_ID] = {
            id: ROOT_ID,
            children: pinnedIds,
            isExpanded: true,
        };

        return {
            ...tree,
            items,
        };
    }, [tree]);

    return {
        tree,
        pinnedTree,
        initTree,
        genNewId,
        addItem,
        removeItem,
        moveItem,
        mutateItem,
        restoreItem,
        deleteItem,
        getPaths,
        showItem,
        checkItemIsShown,
        collapseAllItems,
        loading,
        initLoaded,
    };
};

const NoteTreeState = createContainer(useNoteTree);

export default NoteTreeState;
