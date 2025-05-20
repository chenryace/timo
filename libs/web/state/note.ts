import { useCallback, useState } from 'react';
import { createContainer } from 'unstated-next';
import NoteTreeState from 'libs/web/state/tree';
import { NOTE_DELETED, NOTE_PINNED, NOTE_SHARED } from 'libs/shared/meta';
import useNoteAPI from '../api/note';
import noteCache from '../cache/note';
import { NoteModel } from 'libs/shared/note';
import { useToast } from '../hooks/use-toast';
import { isEmpty, map } from 'lodash';

const useNote = (initData?: NoteModel) => {
    const [note, setNote] = useState<NoteModel | undefined>(initData);
    const { find, abort: abortFindNote } = useNoteAPI();
    const { create, error: createError } = useNoteAPI();
    const { mutate, loading, abort } = useNoteAPI();
    const { addItem, removeItem, mutateItem, genNewId, initTree } =
        NoteTreeState.useContainer();
    const toast = useToast();

    const fetchNote = useCallback(
        async (id: string) => {
            if (!id || id === 'undefined') {
                console.warn(`fetchNote: Invalid id "${id}" provided. Aborting fetch.`);
                return;
            }
            // 如果请求的ID与当前已加载的笔记ID相同，直接返回当前笔记
            if (note?.id === id) {
                console.log('fetchNote: Requested ID matches current note ID. Returning current note.', { id });
                return note;
            }
            console.log('fetchNote', { id });
            const cache = await noteCache.getItem(id);
            if (cache) {
                console.log('从缓存获取笔记', cache);
                setNote(cache);
                return cache; // 如果缓存命中，直接返回缓存数据
            }
            const result = await find(id);

            if (!result) {
                console.log('API获取笔记失败');
                return;
            }

            console.log('API获取笔记成功', result);
            result.content = result.content || '\n';
            setNote(result);
            await noteCache.setItem(id, result);

            return result;
        },
        [find] // 添加 note 作为依赖
    );

    const removeNote = useCallback(
        async (id: string) => {
            console.log('removeNote', { id });
            const payload = {
                deleted: NOTE_DELETED.DELETED,
            };

            setNote((prev) => {
                if (prev?.id === id) {
                    return { ...prev, ...payload };
                }
                return prev;
            });
            await mutate(id, payload);
            await noteCache.mutateItem(id, payload);
            await removeItem(id);
        },
        [mutate, removeItem]
    );

    const mutateNote = useCallback(
        async (id: string, payload: Partial<NoteModel>) => {
            console.log('mutateNote', { id, payload });
            const note = await noteCache.getItem(id);

            if (!note) {
                console.error('mutate note error: 笔记不存在');
                return;
            }

            // 确保包含日期字段
            const updatedPayload = {
                ...payload,
                date: payload.date || new Date().toISOString()
            };

            const diff: Partial<NoteModel> = {};
            map(updatedPayload, (value: any, key: keyof NoteModel) => {
                if (note[key] !== value) {
                    diff[key] = value;
                }
            });

            if (isEmpty(diff)) {
                console.log('无变更，跳过更新');
                return;
            }

            console.log('有变更，更新笔记', diff);
            setNote((prev) => {
                if (prev?.id === id) {
                    return { ...prev, ...updatedPayload };
                }
                return prev;
            });
            await mutate(id, updatedPayload);
            await noteCache.mutateItem(id, updatedPayload);
            await mutateItem(id, {
                data: {
                    ...note,
                    ...updatedPayload,
                },
            });
        },
        [mutate, mutateItem]
    );

    const createNote = useCallback(
        async (body: Partial<NoteModel>) => {
            console.log('createNote', body);
            
            // 确保包含必要的元数据
            const noteWithMeta = {
                ...body,
                date: body.date || new Date().toISOString(),
                deleted: body.deleted || NOTE_DELETED.NORMAL,
                shared: body.shared || NOTE_SHARED.PRIVATE,
                pinned: body.pinned || NOTE_PINNED.UNPINNED
            };
            
            try {
                console.log('调用API创建笔记', noteWithMeta);
                const result = await create(noteWithMeta);

                if (!result) {
                    console.error('创建笔记失败', createError);
                    toast(createError || '创建笔记失败', 'error');
                    return;
                }

                console.log('API创建笔记成功，验证数据');
                
                // 验证API返回的数据与本地数据一致
                const keysToValidateStrict = ['title', 'pid'] as const; // title 和 pid 进行严格验证
                for (const key of keysToValidateStrict) {
                    // 检查 result 是否真的有这个 key，以及 noteWithMeta 是否有这个 key
                    if (Object.prototype.hasOwnProperty.call(noteWithMeta, key) && 
                        noteWithMeta[key as keyof typeof noteWithMeta] !== result[key as keyof typeof result]) {
                        console.error(`创建笔记时，${key}字段与服务器返回的不一致`);
                        console.error(`本地: ${noteWithMeta[key as keyof typeof noteWithMeta]}, 服务器: ${result[key as keyof typeof result]}`);
                        toast(`创建笔记失败：${key}数据验证错误`, 'error');
                        return;
                    }
                }

                // 对 content 字段进行特殊处理
                if (result.content === undefined && noteWithMeta.content !== undefined) {
                    console.warn(`创建笔记时，服务器未返回content字段，使用本地发送的内容。本地内容长度: ${noteWithMeta.content.length}`);
                    result.content = noteWithMeta.content; // 如果服务器未返回content，但我们发送了，则使用我们发送的
                } else if (noteWithMeta.content !== undefined && result.content !== noteWithMeta.content) {
                    // 如果我们发送了content，并且服务器也返回了content，但它们不一致
                    console.error(`创建笔记时，content字段与服务器返回的不一致。本地内容长度: ${noteWithMeta.content?.length}, 服务器内容长度: ${result.content?.length}`);
                    toast(`创建笔记失败：content数据验证错误`, 'error');
                    return;
                }
                
                console.log('数据验证通过，更新本地缓存和树结构');
                
                // 确保内容字段存在，如果经过上述处理后 content 仍为 undefined，则使用 noteWithMeta.content 或默认值
                result.content = result.content || noteWithMeta.content || '\n';
                
                // 更新缓存
                console.log('更新笔记缓存', result);
                await noteCache.setItem(result.id, result);
                
                // 更新本地状态
                setNote(result);
                
                // 确保添加到树结构
                console.log('添加笔记到树结构', result);
                addItem(result);
                // 移除 await initTree() 调用，addItem 应该负责更新树
                console.log('笔记已添加到树结构，依赖 addItem 更新');
                
                toast('创建笔记成功', 'success');
                return result;
            } catch (error) {
                console.error('创建笔记过程中出错', error);
                const errorMessage = error instanceof Error ? error.message : '未知错误';
                toast('创建笔记失败：' + errorMessage, 'error');
                return null;
            }
        },
        [create, addItem, toast, createError, initTree]
    );

    const createNoteWithTitle = useCallback(
        async (title: NoteModel['title']) => {
            console.log('createNoteWithTitle', { title });
            const id = genNewId();
            
            try {
                console.log('调用API创建笔记', { id, title });
                const result = await create({
                    id,
                    title,
                    date: new Date().toISOString() // 添加日期元数据
                });

                if (!result) {
                    console.error('创建笔记失败');
                    toast('创建笔记失败', 'error');
                    return;
                }

                console.log('API创建笔记成功，验证数据');
                
                // 验证API返回的数据与本地数据一致
                if (result.title !== title) {
                    console.error('创建笔记时，标题与服务器返回的不一致');
                    console.error(`本地: ${title}, 服务器: ${result.title}`);
                    toast('创建笔记失败：标题数据验证错误', 'error');
                    return;
                }
                
                console.log('数据验证通过，更新本地缓存和树结构');
                
                // 确保内容字段存在
                result.content = result.content || '\n';
                
                // 更新缓存
                console.log('更新笔记缓存', result);
                await noteCache.setItem(result.id, result);
                
                // 添加到树结构
                console.log('添加笔记到树结构', result);
                addItem(result);
                
                // 刷新树结构
                console.log('刷新树结构');
                await initTree();
                
                toast('创建笔记成功', 'success');
                return { id: result.id };
            } catch (error) {
                console.error('创建笔记过程中出错', error);
                const errorMessage = error instanceof Error ? error.message : '未知错误';
                toast('创建笔记失败：' + errorMessage, 'error');
                return null;
            }
        },
        [create, addItem, genNewId, initTree, toast]
    );

    /**
     * TODO: merge with mutateNote
     */
    const updateNote = useCallback(
        async (data: Partial<NoteModel>) => {
            console.log('updateNote', data);
            abort();

            if (!note?.id) {
                console.error('updateNote error: 笔记ID不存在');
                toast('笔记ID不存在', 'error');
                return;
            }
            
            // 确保包含日期字段
            const updatedData = {
                ...data,
                date: data.date || new Date().toISOString()
            };
            
            try {
                // 先保存本地状态的副本，以便在出错时恢复
                const originalNote = { ...note };
                
                // 临时更新本地状态，但不更新缓存和树结构
                const newNote = {
                    ...note,
                    ...updatedData,
                };
                delete newNote.content;
                setNote(newNote);
                
                console.log('调用API更新笔记', { id: note.id, data: updatedData });
                
                try {
                    const apiResult = await mutate(note.id, updatedData);

                    if (!apiResult) {
                        console.error('API更新笔记失败：mutate did not return valid data, but did not throw. Reverting.');
                        setNote(originalNote); // Revert optimistic update
                        toast('保存失败：服务器未能返回有效的笔记数据。', 'error');
                        throw new Error('API mutate resolved without error but returned no data.');
                    }
                    
                    const validApiResult: NoteModel = apiResult;

                    console.log('API更新笔记成功，验证数据', validApiResult);
                    
                    // 验证API返回的数据与本地数据一致
                    // 注意：validApiResult 现在是完整的 NoteModel，而 updatedData 只是部分更新
                    // 我们应该验证 updatedData 中的字段是否在 validApiResult 中得到了正确的更新
                    const keysToValidate = Object.keys(updatedData) as Array<keyof NoteModel>;
                    for (const key of keysToValidate) {
                        // 对于 content 字段，进行特殊比较，因为服务器可能返回处理过的内容
                        if (key === 'content') {
                            if (updatedData.content !== undefined && updatedData.content !== validApiResult.content) {
                                console.warn('内容验证：本地发送的内容与服务器返回的内容可能不完全一致，这可能是由于服务器端处理（如trimming）导致的。如果这是预期行为，可以忽略此警告。');
                                console.warn(`本地发送: ${updatedData.content}, 服务器返回: ${validApiResult.content}`);
                                // 如果严格要求一致，则取消注释下一行并报错
                                // toast('保存失败：数据验证错误，服务器返回的内容与本地不一致', 'error');
                                // setNote(originalNote);
                                // return;
                            }
                        } else if (key === 'date') {
                            // 对 date 字段进行特殊处理，允许一定的误差，并以服务器返回的为准
                            // 这里不再进行严格比较，因为服务器时间可能与客户端有微小差异
                            // validApiResult.date 将在后续更新中被使用
                            console.log(`日期字段 (${key}) 将使用服务器返回的值: ${validApiResult[key]}`);
                        } else if (updatedData[key] !== validApiResult[key]) {
                            console.error(`字段 ${key} 验证失败，服务器返回的值与预期不一致`);
                            console.error(`本地预期: ${updatedData[key]}, 服务器返回: ${validApiResult[key]}`);
                            setNote(originalNote);
                            toast(`保存失败：数据验证错误 (${key}不一致)`, 'error');
                            return;
                        }
                    }
                    
                    console.log('数据验证通过，更新本地缓存和树结构');

                    // 使用 API 返回的完整数据来更新树和缓存，以确保数据一致性
                    const finalNoteDataForTree = { ...newNote, ...validApiResult }; // 合并本地乐观更新和服务器权威数据
                    delete finalNoteDataForTree.content; // 树结构通常不需要完整内容

                    console.log('更新树结构中的笔记数据', { id: finalNoteDataForTree.id, data: finalNoteDataForTree });
                    await mutateItem(finalNoteDataForTree.id, {
                        data: finalNoteDataForTree,
                    });
                    
                    console.log('更新笔记缓存', { id: note.id, data: validApiResult });
                    await noteCache.mutateItem(note.id, validApiResult!); // 使用服务器返回的完整数据更新缓存
                    
                    // 更新本地 note 状态为服务器返回的最新状态
                    setNote(validApiResult!); // validApiResult is confirmed to be NoteModel here

                    toast('保存成功', 'success');
                    return validApiResult;
                } catch (apiError) {
                    console.error('API调用过程中出错或数据验证失败', apiError);
                    // 恢复原始状态
                    setNote(originalNote);
                    const errorMessage = apiError instanceof Error ? apiError.message : '保存笔记时发生未知错误。';
                    toast('保存失败：' + errorMessage, 'error');
                    // 不返回，让调用者知道操作失败
                    // return; // 如果希望静默失败或返回特定值，可以取消注释或修改
                    throw apiError; // 将错误向上抛出，以便调用者可以处理
                }
            } catch (error) {
                console.error('更新笔记过程中出错', error);
                const errorMessage = error instanceof Error ? error.message : '未知错误';
                toast('保存失败：' + errorMessage, 'error');
                // 恢复原始状态
                const originalNote = await noteCache.getItem(note.id);
                if (originalNote) {
                    setNote(originalNote);
                }
            }
        },
        [abort, toast, note, mutate, mutateItem]
    );

    const initNote = useCallback((note: Partial<NoteModel>) => {
        console.log('initNote', note);
        setNote({
            deleted: NOTE_DELETED.NORMAL,
            shared: NOTE_SHARED.PRIVATE,
            pinned: NOTE_PINNED.UNPINNED,
            editorsize: null,
            id: '-1',
            title: '',
            ...note,
        });
    }, []);

    const findOrCreateNote = useCallback(
        async (id: string, note: Partial<NoteModel>) => {
            console.log('findOrCreateNote', { id, note });
            try {
                const data = await fetchNote(id);
                if (!data) {
                    console.log('笔记不存在，准备创建');
                    throw data;
                }
                console.log('笔记已存在', data);
            } catch (e) {
                console.log('创建笔记', { id, ...note });
                await createNote({
                    id,
                    ...note,
                    date: new Date().toISOString() // 添加日期元数据
                });
            }
        },
        [createNote, fetchNote]
    );

    const apiDeleteNote = useCallback(
        async (deletedNoteId: string) => {
            if (!deletedNoteId || deletedNoteId === 'undefined') {
                console.warn(`handleHardDeleteCleanup: Invalid deletedNoteId "${deletedNoteId}" provided.`);
                return;
            }
            console.log('handleHardDeleteCleanup triggered for note ID:', deletedNoteId);

            // 1. 从本地笔记缓存中移除被删除的笔记条目
            console.log('Removing note from local cache:', deletedNoteId);
            await noteCache.removeItem(deletedNoteId);
            // 开发者提示: 如果您的应用支持笔记的层级结构，并且硬删除父笔记意味着其所有子孙笔记也应被删除，
            // 您可能需要在此处添加逻辑来递归地从缓存中移除所有相关的子孙笔记。
            // 当前的 initTree() 调用会从服务器刷新整个树，这应该能处理子孙笔记在树结构中的移除，
            // 但显式清理缓存可以确保数据一致性并避免潜在的孤立缓存条目。

            // 2. 调用API从服务器重新获取并更新整个树结构
            console.log('Refreshing note tree from server...');
            await initTree();
            console.log('Note tree refreshed.');

            // 3. 如果当前正在查看的笔记被硬删除了，UI需要相应地更新
            if (note?.id === deletedNoteId) {
                console.log('Currently viewed note was deleted. Clearing note view.');
                setNote(undefined); // 清空笔记视图
                toast('当前笔记已被永久删除', 'info'); // 通知用户
                // 导航到默认页面或列表的逻辑通常在UI组件层完成，
                // 例如，通过 useEffect 监听 `note` 状态的变化。
            }
        },
        [note, setNote, initTree, toast] 
    );

    return {
        note,
        fetchNote,
        abortFindNote,
        createNote,
        findOrCreateNote,
        createNoteWithTitle,
        updateNote,
        removeNote,
        mutateNote,
        initNote,
        loading,
        setNote, // 添加 setNote
        apiDeleteNote, // 新增：处理硬删除后的清理工作
    };
};

const NoteState = createContainer(useNote);

export default NoteState;
