import NoteState from 'libs/web/state/note';
import { has } from 'lodash';
import router, { useRouter } from 'next/router';
import { useRef } from 'react';
import { useCallback, useEffect } from 'react';
import NoteTreeState from 'libs/web/state/tree';
import NoteNav from 'components/note-nav';
import UIState from 'libs/web/state/ui';
import noteCache from 'libs/web/cache/note';
import useSettingsAPI from 'libs/web/api/settings';
import dynamic from 'next/dynamic';
import { useToast } from 'libs/web/hooks/use-toast';
import DeleteAlert from 'components/editor/delete-alert';
// 移除直接导入EditorState
// import EditorState from 'libs/web/state/editor';

const MainEditor = dynamic(() => import('components/editor/main-editor'));

export const EditContainer = () => {
    const {
        title: { updateTitle },
        settings: { settings },
    } = UIState.useContainer();
    const { genNewId } = NoteTreeState.useContainer();
    const { fetchNote, abortFindNote, findOrCreateNote, initNote, note, setNote } =
        NoteState.useContainer();
    // 移除对EditorState的直接使用
    // const { saveNote, hasLocalChanges } = EditorState.useContainer();
    const { query } = useRouter();
    const { mutate: mutateSettings } = useSettingsAPI();
    const toast = useToast();
    const dailyNoteLoadLock = useRef(false);

    const loadNoteById = useCallback(
        async (currentId: string, currentIsNew: boolean, currentPid?: string) => {
            if (currentId === undefined || currentId === 'undefined') {
                console.warn('Attempted to load note with undefined ID. Aborting.');
                // 可选择重定向到主页或显示错误信息
                // await router.push('/', undefined, { shallow: true });
                return;
            }
            // daily notes
            if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(currentId)) {
                if (dailyNoteLoadLock.current) {
                    console.log(`Daily note ${currentId} is already being loaded. Skipping.`);
                    return;
                }
                dailyNoteLoadLock.current = true;
                try {
                    await findOrCreateNote(currentId, {
                        id: currentId,
                        title: currentId,
                        content: '\n',
                        pid: settings.daily_root_id,
                    });
                } finally {
                    dailyNoteLoadLock.current = false;
                }
            } else if (currentId === 'new') {
                const url = `/${genNewId()}?new` + (currentPid ? `&pid=${currentPid}` : '');
                await router.replace(url, undefined, { shallow: true });
            } else if (currentId && !currentIsNew) { // ID 存在，且不是 new 模式
                try {
                    const result = await fetchNote(currentId);
                    if (!result) { // Note not found or deleted
                        toast('笔记未找到或已被删除', 'error');
                        await router.push('/', undefined, { shallow: true });
                        return; // Important to return after navigation
                    }
                } catch (msg) {
                    const err = msg as Error;
                    if (err.name !== 'AbortError') {
                        toast(err.message, 'error');
                        await router.push('/', undefined, { shallow: true });
                    }
                }
            } else { // currentId 存在，且 currentIsNew 为 true (e.g., /note123?new=1)
                const cachedNote = await noteCache.getItem(currentId);
                if (cachedNote) {
                    setNote(cachedNote); // 使用 NoteState 的 setNote
                    // 清理 URL 中的 ?new=1, 只有当确实是从 new 状态转换时才 replace
                    if (currentIsNew) { 
                        await router.replace(`/${currentId}`, undefined, { shallow: true });
                    }
                } else {
                    initNote({
                        id: currentId,
                        content: '\n',
                    });
                }
            }

            if (!currentIsNew && currentId !== 'new') {
                await mutateSettings({
                    last_visit: `/${currentId}`,
                });
            }
        },
        [
            findOrCreateNote,
            settings.daily_root_id,
            genNewId,
            fetchNote, // from NoteState
            initNote,  // from NoteState, ensure it's stable or add to deps if needed
            setNote,   // from NoteState
            toast,
            mutateSettings,
            router,    // for router.replace and router.push
            query      // for router.replace({ query: { ...query }})
        ]
    );

    const prevIdRef = useRef<string | undefined>();
    const prevIsNewRef = useRef<boolean | undefined>();

    useEffect(() => {
        const currentId = query.id as string;
        const currentIsNew = has(query, 'new');
        const currentPid = query.pid as string;

        // 检查是否是由于内部 replace(`/${id}`) 导致的 isNew 变化
        if (
            prevIdRef.current === currentId &&
            prevIsNewRef.current === true &&
            currentIsNew === false
        ) {
            console.log(`Skipping useEffect for id ${currentId} due to internal URL cleanup.`);
            prevIdRef.current = currentId;
            prevIsNewRef.current = currentIsNew;
            return;
        }

        prevIdRef.current = currentId;
        prevIsNewRef.current = currentIsNew;

        abortFindNote();
        if (currentId && currentId !== 'undefined') { // 确保 id 有效
            loadNoteById(currentId, currentIsNew, currentPid)
                ?.catch((v) => console.error('Could not load note: %O', v));
        } else if (currentId === 'undefined') {
            console.warn('useEffect detected undefined ID, not loading note.');
        }
    }, [query, abortFindNote, loadNoteById]); // 依赖 query (包含 id, new, pid) 和 loadNoteById

    useEffect(() => {
        updateTitle(note?.title);
    }, [note?.title, updateTitle]);
    
    // 移除键盘快捷键支持，将在MainEditor组件中处理
    // useEffect(() => {
    //     const handleKeyDown = (e: KeyboardEvent) => {
    //         if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    //             e.preventDefault();
    //             if (hasLocalChanges) {
    //                 saveNote()
    //                     .catch(error => console.error('保存失败', error));
    //             }
    //         }
    //     };
    //     
    //     document.addEventListener('keydown', handleKeyDown);
    //     return () => document.removeEventListener('keydown', handleKeyDown);
    // }, [hasLocalChanges, saveNote]);
    
    // 移除页面离开提示，将在MainEditor组件中处理
    // useEffect(() => {
    //     const handleBeforeUnload = (e: BeforeUnloadEvent) => {
    //         if (hasLocalChanges) {
    //             e.preventDefault();
    //             e.returnValue = '';
    //             return '';
    //         }
    //     };
    //     
    //     window.addEventListener('beforeunload', handleBeforeUnload);
    //     return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    // }, [hasLocalChanges]);

    return (
        <>
            <NoteNav />
            <DeleteAlert />
            <section className="h-full">
                <MainEditor note={note} />
            </section>
        </>
    );
};
