import EditTitle from './edit-title';
import Editor, { EditorProps } from './editor';
import Backlinks from './backlinks';
import EditorState from 'libs/web/state/editor';
import UIState from 'libs/web/state/ui';
import { FC, useEffect, useCallback } from 'react';
import { NoteModel } from 'libs/shared/note';
import { EDITOR_SIZE } from 'libs/shared/meta';
import useI18n from 'libs/web/hooks/use-i18n';
import HotkeyTooltip from '../hotkey-tooltip';
import IconButton from '../icon-button';
import classNames from 'classnames';
import { MouseEvent } from 'react';

const MainEditor: FC<
    EditorProps & {
        note?: NoteModel;
        isPreview?: boolean;
        className?: string;
    }
> = ({ className, note, isPreview, ...props }) => {
    const {
        settings: { settings },
    } = UIState.useContainer();
    let editorWidthClass: string;
    switch (note?.editorsize ?? settings.editorsize) {
        case EDITOR_SIZE.SMALL:
            editorWidthClass = 'max-w-prose';
            break;
        case EDITOR_SIZE.LARGE:
            editorWidthClass = 'max-w-4xl';
            break;
        case EDITOR_SIZE.AS_WIDE_AS_POSSIBLE:
            // until we reach md size, just do LARGE to have consistency
            editorWidthClass = 'max-w-4xl md:max-w-full md:mx-20';
            break;
    }
    const articleClassName =
        className || `pt-16 md:pt-40 px-6 m-auto h-full ${editorWidthClass}`;

    return (
        <EditorState.Provider initialState={note}>
            <EditorContent 
                articleClassName={articleClassName} 
                isPreview={isPreview} 
                readOnly={props.readOnly} 
            />
        </EditorState.Provider>
    );
};

// 创建一个内部组件来使用EditorState
const EditorContent: FC<{
    articleClassName: string;
    isPreview?: boolean;
    readOnly?: boolean;
}> = ({ articleClassName, isPreview, readOnly }) => {
    const { saveNote, hasLocalChanges } = EditorState.useContainer();
    
    // 添加键盘快捷键支持
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // 添加Ctrl+S (或Mac上的Cmd+S)快捷键
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (hasLocalChanges) {
                    saveNote()
                        .catch(error => console.error('保存失败', error));
                }
            }
        };
        
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [hasLocalChanges, saveNote]);
    
    // 添加页面离开提示
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (hasLocalChanges) {
                // 显示标准的"离开页面"提示
                e.preventDefault();
                e.returnValue = '';
                return '';
            }
        };
        
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [hasLocalChanges]);
    
    return (
        <>
            <EditorNavButtons />
            <article className={articleClassName}>
                <EditTitle readOnly={readOnly} />
                <Editor isPreview={isPreview} readOnly={readOnly} />
                {!isPreview && <Backlinks />}
            </article>
        </>
    );
};

// 创建一个新组件来处理导航栏中的保存按钮
const EditorNavButtons: FC = () => {
    const { t } = useI18n();
    const { saveNote, hasLocalChanges, discardChanges } = EditorState.useContainer();
    const { note } = EditorState.useContainer();
    
    // 添加保存按钮点击处理
    const handleClickSave = useCallback(
        async (event: MouseEvent) => {
            event.stopPropagation();
            await saveNote();
        },
        [saveNote]
    );
    
    // 添加丢弃更改按钮点击处理
    const handleClickDiscard = useCallback(
        (event: MouseEvent) => {
            event.stopPropagation();
            if (window.confirm('确定要丢弃所有未保存的更改吗？')) {
                discardChanges();
            }
        },
        [discardChanges]
    );
    
    // 将按钮添加到文档中的固定位置
    return (
        <div className="fixed top-2 right-40 z-20 flex items-center">
            {/* 添加保存状态指示器 */}
            {hasLocalChanges && (
                <div className="mr-2 text-xs text-red-500 font-medium">
                    未保存
                </div>
            )}
            
            {/* 添加保存按钮 */}
            <HotkeyTooltip text={t('保存笔记 (Ctrl+S)')}>
                <IconButton
                    onClick={handleClickSave}
                    className={classNames("mr-2", {
                        "text-blue-500": hasLocalChanges,
                        "animate-pulse": hasLocalChanges
                    })}
                    disabled={!note || !hasLocalChanges}
                    icon="DocumentText"
                />
            </HotkeyTooltip>
            
            {/* 添加丢弃更改按钮 */}
            {hasLocalChanges && (
                <HotkeyTooltip text={t('丢弃更改')}>
                    <IconButton
                        onClick={handleClickDiscard}
                        className="mr-2"
                        disabled={!note || !hasLocalChanges}
                        icon="Trash"
                    />
                </HotkeyTooltip>
            )}
        </div>
    );
};

export default MainEditor;
