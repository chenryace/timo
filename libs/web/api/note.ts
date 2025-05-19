import { NoteModel } from 'libs/shared/note';
import { useCallback } from 'react';
import noteCache from '../cache/note';
import useFetcher from './fetcher';

export default function useNoteAPI() {
    const { loading, request, abort, error } = useFetcher();

    const find = useCallback(
        async (id: string) => {
            console.log('API调用: 查找笔记', { id });
            const result = await request<null, NoteModel>({
                method: 'GET',
                url: `/api/notes/${id}`,
            });
            console.log('API调用结果: 查找笔记', result);
            return result;
        },
        [request]
    );

    const create = useCallback(
        async (body: Partial<NoteModel>) => {
            console.log('API调用: 创建笔记', body);
            // 确保包含日期字段
            const noteWithDate = {
                ...body,
                date: body.date || new Date().toISOString()
            };
            
            try {
                const result = await request<Partial<NoteModel>, NoteModel>(
                    {
                        method: 'POST',
                        url: `/api/notes`,
                    },
                    noteWithDate
                );
                
                if (!result) {
                    console.error('创建笔记失败：服务器未返回数据');
                    throw new Error('创建笔记失败');
                }
                
                console.log('API调用结果: 创建笔记成功', result);
                return result;
            } catch (error) {
                console.error('创建笔记过程中出错', error);
                throw error;
            }
        },
        [request]
    );

    const mutate = useCallback(
        async (id: string, body: Partial<NoteModel>) => {
            console.log('API调用: 更新笔记', { id, body });

            // 确保包含日期字段
            const updatedBody = {
                ...body,
                date: body.date || new Date().toISOString()
            };

            let latestNoteData: NoteModel | undefined;
            let contentSaved = false;
            let metaSaved = false;

            try {
                // 如果包含内容，先保存内容
                if (updatedBody.content !== undefined) { // Check if content exists in the update
                    console.log('保存笔记内容');
                    try {
                        latestNoteData = await request<Partial<NoteModel>, NoteModel>(
                            {
                                method: 'POST',
                                url: `/api/notes/${id}`,
                            },
                            { content: updatedBody.content } // Only send content
                        );

                        if (!latestNoteData) {
                            console.error('保存笔记内容失败：服务器未返回有效数据');
                            throw new Error('保存笔记内容失败：服务器未返回有效数据');
                        }

                        contentSaved = true;
                        console.log('保存笔记内容成功', latestNoteData);
                    } catch (contentError) {
                        console.error('保存笔记内容请求失败', contentError);
                        throw new Error('保存笔记内容失败：' + (contentError instanceof Error ? contentError.message : '网络错误'));
                    }
                }

                // 如果有其他元数据，再保存元数据
                const metaData = { ...updatedBody };
                delete metaData.content; // Remove content as it's handled separately

                if (Object.keys(metaData).length > 0) {
                    console.log('保存笔记元数据', metaData);
                    try {
                        latestNoteData = await request<Partial<NoteModel>, NoteModel>(
                            {
                                method: 'POST',
                                url: `/api/notes/${id}/meta`,
                            },
                            metaData // Send only metadata
                        );

                        if (!latestNoteData) {
                            console.error('保存笔记元数据失败：服务器未返回有效数据');
                            throw new Error('保存笔记元数据失败：服务器未返回有效数据');
                        }

                        metaSaved = true;
                        console.log('保存笔记元数据成功', latestNoteData);
                    } catch (metaError) {
                        console.error('保存笔记元数据请求失败', metaError);
                        throw new Error('保存笔记元数据失败：' + (metaError instanceof Error ? metaError.message : '网络错误'));
                    }
                }

                // 如果既没有内容也没有元数据更新（理论上不应发生，但作为防御性编程）
                // 如果既没有内容也没有元数据更新（理论上不应发生，但作为防御性编程）
                if (!contentSaved && !metaSaved) {
                    console.warn('没有实际需要保存的数据, 尝试获取最新笔记状态');
                    latestNoteData = await find(id);
                    if (!latestNoteData) {
                        console.error('更新笔记失败：无法获取笔记的最新状态，即使没有数据变更。');
                        throw new Error('更新笔记失败：无法获取笔记的最新状态。');
                    }
                }

                console.log('API调用结果: 更新笔记完成', latestNoteData);
                return latestNoteData; // Return the latest full note data from the server
            } catch (error) {
                console.error('保存笔记过程中出错', error);
                throw error;
            }
        },
        [request, find] // Added find dependency
    );

    // fetch note from cache or api
    const fetch = useCallback(
        async (id: string) => {
            console.log('获取笔记', { id, fromCache: true });
            const cache = await noteCache.getItem(id);
            if (cache) {
                console.log('从缓存获取笔记成功', cache);
                return cache;
            }
            
            console.log('缓存中无笔记，从API获取');
            const note = await find(id);
            if (note) {
                console.log('从API获取笔记成功，更新缓存');
                await noteCache.setItem(id, note);
            } else {
                console.log('从API获取笔记失败');
            }

            return note;
        },
        [find]
    );

    return {
        loading,
        error,
        abort,
        find,
        create,
        mutate,
        fetch,
    };
}
