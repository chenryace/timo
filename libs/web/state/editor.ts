import { useRouter } from 'next/router';
import {
    useCallback,
    MouseEvent as ReactMouseEvent,
    useState,
    useRef,
    useEffect,
} from 'react';
import { searchNote, searchRangeText } from 'libs/web/utils/search';
import { NOTE_DELETED } from 'libs/shared/meta';
import { isNoteLink, NoteModel } from 'libs/shared/note';
import { useToast } from 'libs/web/hooks/use-toast';
import PortalState from 'libs/web/state/portal';
import { NoteCacheItem, noteCacheInstance } from 'libs/web/cache'; // 从 libs/web/cache 导入 noteCacheInstance
import noteCache from 'libs/web/cache/note';
import { createContainer } from 'unstated-next';
import MarkdownEditor from '@notea/rich-markdown-editor';
import { useDebouncedCallback } from 'use-debounce';
import { ROOT_ID } from 'libs/shared/tree';
import { has } from 'lodash';
import UIState from './ui';
import NoteTreeState from './tree';
import NoteState from './note';

const onSearchLink = async (keyword: string) => {
    const list = await searchNote(keyword, NOTE_DELETED.NORMAL);

    return list.map((item) => ({
        title: item.title,
        // todo 路径
        subtitle: searchRangeText({
            text: item.rawContent || '',
            keyword,
            maxLen: 40,
        }).match,
        url: `/${item.id}`,
    }));
};

const useEditor = (initNote?: NoteModel) => {
    const {
        createNoteWithTitle,
        updateNote,
        createNote,
        note: noteProp,
    } = NoteState.useContainer();
    const note = initNote ?? noteProp;
    const {
        ua: { isBrowser },
    } = UIState.useContainer();
    const router = useRouter();
    const toast = useToast();
    const editorEl = useRef<MarkdownEditor>(null);
    const treeState = NoteTreeState.useContainer();
    
    // 添加本地更改状态
    const [hasLocalChanges, setHasLocalChanges] = useState<boolean>(false);
    const [localContent, setLocalContent] = useState<string>('');
    const [localTitle, setLocalTitle] = useState<string>('');
    
    // 添加编辑器渲染状态
    const [editorKey, setEditorKey] = useState<number>(0);
    
    // 初始化本地内容，优化缓存处理
    useEffect(() => {
        if (note) {
            const noteId = note.id;
            console.log('初始化编辑器内容', { id: noteId });

            // 异步加载草稿
            const loadDraft = async () => {
                try {
                    // 直接使用 noteCacheInstance 获取字符串草稿
                    const draftContent = await noteCacheInstance.getItem<string>(`draft_content_${noteId}`);
                    const draftTitle = await noteCacheInstance.getItem<string>(`draft_title_${noteId}`);

                    if (draftContent !== null || draftTitle !== null) {
                        console.log('发现 IndexedDB 草稿', { draftContent: draftContent !== null, draftTitle: draftTitle !== null });
                        
                        // 直接使用获取到的字符串草稿，如果为 null 则回退
                        const contentValue = draftContent ?? note?.content ?? '';
                        const titleValue = draftTitle ?? note?.title ?? '';

                        setLocalContent(contentValue);
                        setLocalTitle(titleValue);
                        setHasLocalChanges(true);
                    } else {
                        // 没有草稿，使用服务器数据
                        setLocalContent(note.content || '');
                        setLocalTitle(note.title || '');
                        setHasLocalChanges(false);
                    }
                } catch (error) {
                    console.error('加载 IndexedDB 草稿失败', error);
                    // 加载失败，回退到服务器数据
                    setLocalContent(note.content || '');
                    setLocalTitle(note.title || '');
                    setHasLocalChanges(false);
                }

                // 清除localStorage中可能存在的旧数据 (保留以防万一，但新逻辑不应再写入)
                localStorage.removeItem(`note_content_${noteId}`);
                localStorage.removeItem(`note_title_${noteId}`);

                // 强制编辑器重新渲染
                setEditorKey(prev => prev + 1);

                // 清除与当前笔记无关的缓存
                // clearIrrelevantCache(noteId);
            };

            loadDraft();
        }
    }, [note]); // 依赖项保持不变
    

    const onNoteChange = useDebouncedCallback(
        async (data: Partial<NoteModel>) => {
            const isNew = has(router.query, 'new');

            if (isNew) {
                // 对于新笔记，实际的创建操作由 saveNote 函数在用户操作时处理。
                // 此处的回调不应自动创建笔记，以避免重复创建。
                console.log('onNoteChange: New note, changes are local. Save manually to create.');
                return;
            } else {
                // 对于已存在的笔记，进行更新。
                if (note?.id) {
                    console.log(`onNoteChange: Updating existing note ${note.id} with data:`, data);
                    await updateNote(data);
                } else {
                    console.warn('onNoteChange: Attempted to update note, but note.id is missing.');
                }
            }
        },
        500
    );

    const onCreateLink = useCallback(
        async (title: string) => {
            const result = await createNoteWithTitle(title);

            if (!result) {
                throw new Error('todo');
            }

            return `/${result.id}`;
        },
        [createNoteWithTitle]
    );

    const onClickLink = useCallback(
        (href: string) => {
            if (isNoteLink(href.replace(location.origin, ''))) {
                router.push(href, undefined, { shallow: true })
                    .catch((v) => console.error('Error whilst pushing href to router: %O', v));
            } else {
                window.open(href, '_blank');
            }
        },
        [router]
    );

    const { preview, linkToolbar } = PortalState.useContainer();

    const onHoverLink = useCallback(
        (event: MouseEvent | ReactMouseEvent) => {
            if (!isBrowser || editorEl.current?.props.readOnly) {
                return true;
            }
            const link = event.target as HTMLLinkElement;
            const href = link.getAttribute('href');
            if (link.classList.contains('bookmark')) {
                return true;
            }
            if (href) {
                if (isNoteLink(href)) {
                    preview.close();
                    preview.setData({ id: href.slice(1) });
                    preview.setAnchor(link);
                } else {
                    linkToolbar.setData({ href, view: editorEl.current?.view });
                    linkToolbar.setAnchor(link);
                }
            } else {
                preview.setData({ id: undefined });
            }
            return true;
        },
        [isBrowser, preview, linkToolbar]
    );

    const [backlinks, setBackLinks] = useState<NoteCacheItem[]>();

    const getBackLinks = useCallback(async () => {
        console.log('获取反向链接', note?.id);
        const linkNotes: NoteCacheItem[] = [];
        if (!note?.id) return linkNotes;
        setBackLinks([]);
        await noteCache.iterate<NoteCacheItem, void>((value) => {
            if (value.linkIds?.includes(note.id)) {
                linkNotes.push(value);
            }
        });
        setBackLinks(linkNotes);
    }, [note?.id]);

    // 修改为不再自动保存的版本
    const onEditorChange = useCallback(
        (value: () => string): void => {
            const newContent = value();
            console.log('编辑器内容变更', { length: newContent.length });

            // 更新本地状态
            setLocalContent(newContent);
            setHasLocalChanges(true);

            // 保存到 IndexedDB 作为草稿 - 直接使用 noteCacheInstance
            if (note?.id) {
                noteCacheInstance.setItem(`draft_content_${note.id}`, newContent)
                    .catch(err => console.error('保存内容草稿到 IndexedDB 失败', err));
            }
        },
        [note]
    );

    // 添加标题变更处理
    const onTitleChange = useCallback(
        (title: string): void => {
            console.log('标题变更', { title });

            // 更新本地状态
            setLocalTitle(title);
            setHasLocalChanges(true);

            // 保存到 IndexedDB 作为草稿 - 直接使用 noteCacheInstance
            if (note?.id) {
                noteCacheInstance.setItem(`draft_title_${note.id}`, title)
                    .catch(err => console.error('保存标题草稿到 IndexedDB 失败', err));
            }
        },
        [note]
    );

    // 添加手动保存函数，确保更新元数据和树结构
    const saveNote = useCallback(async () => {
        if (!note?.id) return false;
        const noteId = note.id; // 保存ID，防止note对象在异步操作中变化

        try {
            console.log('保存笔记', { id: noteId, localContent, localTitle });

            // 设置保存状态指示器
            const saveStartTime = Date.now();
            toast('正在保存...', 'info');
            
            // 对于新笔记的特殊处理
            const isNew = has(router.query, 'new');
            let saveResult;
            
            if (isNew) {
                // 确保包含必要的元数据，特别是日期和pid
                const data = {
                    content: localContent,
                    title: localTitle,
                    pid: (router.query.pid as string) || ROOT_ID,
                    date: new Date().toISOString() // 添加日期元数据
                };
                
                console.log('创建新笔记', data);
                saveResult = await createNote({ ...note, ...data });
                
                // 204状态码会返回空对象，这是正常情况
                if (saveResult === undefined) {
                    console.error('创建笔记失败');
                    return false;
                }
                
                const noteUrl = `/${saveResult?.id}`;
                if (router.asPath !== noteUrl) {
                    await router.replace(noteUrl, undefined, { shallow: true });
                }
            } else {
                // 保存现有笔记，确保包含日期元数据
                console.log('更新现有笔记', { content: localContent, title: localTitle });
                saveResult = await updateNote({
                    content: localContent,
                    title: localTitle,
                    date: new Date().toISOString() // 添加日期元数据
                });
                
                // 204状态码会返回空对象，这是正常情况
                if (saveResult === undefined) {
                    console.error('更新笔记失败');
                    return false;
                }
            }
            
            // 验证返回的数据
            if (saveResult) {
                console.log('验证保存结果', saveResult);
                
                // 验证内容
                if (saveResult.content !== localContent) {
                    console.error('内容验证失败');
                    console.error(`本地: ${localContent.substring(0, 50)}...`);
                    console.error(`服务器: ${saveResult.content?.substring(0, 50)}...`);
                    toast('保存失败：内容验证错误', 'error');
                    return false;
                }
                
                // 验证标题
                if (saveResult.title !== localTitle) {
                    console.error('标题验证失败');
                    console.error(`本地: ${localTitle}`);
                    console.error(`服务器: ${saveResult.title}`);
                    toast('保存失败：标题验证错误', 'error');
                    return false;
                }
                
                console.log('数据验证通过');
            }
            
            // 清除本地更改标记
            setHasLocalChanges(false);
            
            // 清除 IndexedDB 草稿 - 直接使用 noteCacheInstance
            try {
                await noteCacheInstance.removeItem(`draft_content_${noteId}`);
                await noteCacheInstance.removeItem(`draft_title_${noteId}`);
                console.log('IndexedDB 草稿已清除');
            } catch (error) {
                console.error('清除 IndexedDB 草稿失败', error);
            }

            // 清除localStorage (保留以防万一)
            localStorage.removeItem(`note_content_${noteId}`);
            localStorage.removeItem(`note_title_${noteId}`);

            // 保存成功后，刷新树结构以确保侧栏正确显示
            if (treeState && typeof treeState.initTree === 'function') {
                console.log('刷新树结构');
                await treeState.initTree();
            }

            // 强制编辑器重新渲染，解决Markdown渲染问题
            setEditorKey(prev => prev + 1);

            // 计算保存耗时
            const saveTime = Date.now() - saveStartTime;
            console.log(`保存完成，耗时: ${saveTime}ms`);
            
            // 确保至少显示保存成功提示500ms，避免闪烁
            if (saveTime < 500) {
                await new Promise(resolve => setTimeout(resolve, 500 - saveTime));
            }
            
            // 显示保存成功提示
            toast('保存成功', 'success');
            
            return true;
        } catch (error) {
            console.error('保存失败', error);
            // 修复类型错误：将error对象正确处理为可能包含message属性的对象
            const errorMessage = error instanceof Error ? error.message : '请重试';
            toast('保存失败：' + errorMessage, 'error');
            return false;
        }
    }, [note, localContent, localTitle, updateNote, createNote, router, toast, treeState]);

    
    // 添加带重试的保存函数
    const saveNoteWithRetry = useCallback(async (retryCount = 3) => {
        for (let i = 0; i < retryCount; i++) {
            try {
                const result = await saveNote();
                if (result) return true;
            } catch (error) {
                console.error(`保存失败，尝试重试 (${i+1}/${retryCount})`, error);
                if (i === retryCount - 1) {
                    toast('保存失败，请手动刷新页面后重试', 'error');
                    return false;
                }
                // 等待一段时间后重试
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        return false;
    }, [saveNote, toast]);
    
    // 添加丢弃更改函数
    const discardChanges = useCallback(async () => { // 改为 async
        if (!note) return;
        const noteId = note.id;

        console.log('丢弃更改', { id: noteId });

        // 恢复到原始内容
        setLocalContent(note.content || '');
        setLocalTitle(note.title || '');
        setHasLocalChanges(false);

        // 清除 IndexedDB 草稿
        try {
            await noteCache.removeItem(`draft_content_${noteId}`);
            await noteCache.removeItem(`draft_title_${noteId}`);
            console.log('IndexedDB 草稿已清除');
        } catch (error) {
            console.error('清除 IndexedDB 草稿失败', error);
        }

        // 清除localStorage (保留以防万一)
        localStorage.removeItem(`note_content_${noteId}`);
        localStorage.removeItem(`note_title_${noteId}`);

        // 强制编辑器重新渲染，解决Markdown渲染问题
        setEditorKey(prev => prev + 1);

        toast('已丢弃更改', 'info');
    }, [note, toast]);
    
    // 添加强制重新渲染函数
    const forceRender = useCallback(() => {
        console.log('强制编辑器重新渲染');
        setEditorKey(prev => prev + 1);
    }, []);

    return {
        onCreateLink,
        onSearchLink,
        onClickLink,
        onHoverLink,
        getBackLinks,
        onEditorChange,
        onNoteChange,
        backlinks,
        editorEl,
        note,
        // 新增的手动保存相关函数和状态
        saveNote,
        saveNoteWithRetry,
        discardChanges,
        hasLocalChanges,
        localContent,
        localTitle,
        onTitleChange,
        // 编辑器渲染相关
        editorKey,
        forceRender
    };
};

const EditorState = createContainer(useEditor);

export default EditorState;
