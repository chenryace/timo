import { moveItemOnTree, mutateTree, TreeData, TreeItem } from '@atlaskit/tree';
import { NoteModel } from 'libs/shared/note';
import { cloneDeep, forEach, pull, reduce } from 'lodash';

export interface TreeItemModel extends TreeItem {
    id: string;
    data?: NoteModel;
    children: string[];
}

export interface TreeModel extends TreeData {
    rootId: string;
    items: Record<string, TreeItemModel>;
}

export const ROOT_ID = 'root';

export const DEFAULT_TREE: TreeModel = {
    rootId: ROOT_ID,
    items: {
        root: {
            id: ROOT_ID,
            children: [],
        },
    },
};

export interface MovePosition {
    parentId: string;
    index: number;
}

function addItem(tree: TreeModel, id: string, pid = ROOT_ID) {
    tree.items[id] = tree.items[id] || {
        id,
        children: [],
    };

    const parentItem = tree.items[pid];

    if (parentItem) {
        parentItem.children = [...parentItem.children, id];
    } else {
        throw new Error(`Parent ID '${pid}' does not refer to a valid item`);
    }

    return tree;
}

function mutateItem(tree: TreeModel, id: string, data: Partial<TreeItemModel>) {
    if (data.data) {
        data.data = {
            ...tree.items[id]?.data,
            ...data.data,
        };
    }

    return mutateTree(tree, id, data) as TreeModel;
}

function removeItem(tree: TreeModel, id: string) {
    forEach(tree.items, (item) => {
        if (item.children.includes(id)) {
            pull(item.children, id);
            return false;
        }
    });

    return cloneDeep(tree);
}

function moveItem(
    tree: TreeModel,
    source: MovePosition,
    destination?: MovePosition
) {
    if (!destination) {
        return tree;
    }

    return moveItemOnTree(tree, source, destination) as TreeModel;
}

/**
 * 从原父节点上移除，添加到新的父节点上
 */
function restoreItem(tree: TreeModel, id: string, pid = ROOT_ID) {
    tree = removeItem(tree, id);
    tree = addItem(tree, id, pid);

    return tree;
}

function deleteItem(tree: TreeModel, id: string): TreeModel {
    // 防止删除根节点
    if (id === ROOT_ID) {
        console.warn("Attempted to delete ROOT_ID, operation aborted");
        return cloneDeep(tree);
    }
    
    let newTree = cloneDeep(tree);

    // 1. 获取所有要删除的节点 ID（包括自身和所有子孙节点）
    // flattenTree(tree, rootId) 返回 rootId 下的所有子孙节点，不包括 rootId 本身
    const childrenAndGrandchildren = flattenTree(newTree, id);
    const allIdsToDelete = [id, ...childrenAndGrandchildren.map(item => item.id)];

    // 2. 从父节点的 children 数组中移除原始 id
    // 遍历所有 item，找到包含要删除 id 的父节点
    forEach(newTree.items, (item) => {
        if (item.children.includes(id)) {
            pull(item.children, id);
            // 通常一个节点只有一个父节点，但以防万一，不立即返回
        }
    });

    // 3. 从 items 中删除所有收集到的 ID (自身和所有子孙)
    allIdsToDelete.forEach(itemId => {
        // 再次确保不会删除ROOT_ID
        if (itemId !== ROOT_ID) {
            delete newTree.items[itemId];
        }
    });

    return newTree;
}

const flattenTree = (
    tree: TreeModel,
    rootId = tree.rootId
): TreeItemModel[] => {
    if (!tree.items[rootId]) {
        return [];
    }

    return reduce<string, TreeItemModel[]>(
        tree.items[rootId].children,
        (accum, itemId) => {
            const item = tree.items[itemId];
            const children = flattenTree({
                rootId: item.id,
                items: tree.items,
            });

            return [...accum, item, ...children];
        },
        []
    );
};

export type HierarchicalTreeItemModel = Omit<TreeItemModel, 'children'> & {
    children: HierarchicalTreeItemModel[];
};

export function makeHierarchy(
    tree: TreeModel,
    rootId = tree.rootId
): HierarchicalTreeItemModel | false {
    if (!tree.items[rootId]) {
        return false;
    }

    const root = tree.items[rootId];

    return {
        ...root,
        children: root.children
            .map((v) => makeHierarchy(tree, v))
            .filter((v) => !!v) as HierarchicalTreeItemModel[],
    };
}

export function cleanItemModel(model: Partial<TreeItemModel>): TreeItemModel {
    if (!model.id) throw new Error("Missing id on tree model");

    const children = model.children ?? [];

    return {
        ...model, // In case
        id: model.id,
        children,
        hasChildren: children.length > 0,
        data: model.data,
        isExpanded: model.isExpanded ?? false,
    };
}
export function cleanTreeModel(model: Partial<TreeModel>): TreeModel {
    const items: TreeModel["items"] = {};
    if (model.items) {
        for (const itemId in model.items) {
            const item = model.items[itemId];
            if (!item) {
                continue;
            }

            const cleanedItem = cleanItemModel(item);
            const children = [];
            for (const child of cleanedItem.children) {
                if (child && model.items[child]) {
                    children.push(child);
                }
            }

            items[itemId] = {
                ...cleanedItem,
                children
            };
        }
    }

    // 确保ROOT_ID始终存在
    if (!items[ROOT_ID]) {
        items[ROOT_ID] = {
            id: ROOT_ID,
            children: [],
            hasChildren: false,
            isExpanded: true
        };
    }

    return {
        ...model, // In case
        rootId: model.rootId ?? ROOT_ID,
        items: items
    };

}

const TreeActions = {
    addItem,
    mutateItem,
    removeItem,
    moveItem,
    restoreItem,
    deleteItem,
    flattenTree,
    makeHierarchy,
    cleanTreeModel,
    cleanItemModel
};

export default TreeActions;
