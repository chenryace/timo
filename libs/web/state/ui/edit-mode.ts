import { useState, useCallback } from 'react';
import { useRouter } from 'next/router';

interface EditModeState {
    isEditing: boolean;
    hasUnsavedChanges: boolean;
}

export default function useEditMode(initialState: Partial<EditModeState> = {}) {
    const [state, setState] = useState<EditModeState>({
        isEditing: false, // 默认为预览模式
        hasUnsavedChanges: false,
        ...initialState,
    });
    const router = useRouter();

    // 切换编辑/预览模式
    const toggleEditMode = useCallback(() => {
        setState((prev) => ({
            ...prev,
            isEditing: !prev.isEditing,
        }));
    }, []);

    // 设置是否有未保存的更改
    const setHasUnsavedChanges = useCallback((value: boolean) => {
        setState((prev) => ({
            ...prev,
            hasUnsavedChanges: value,
        }));
    }, []);

    // 设置为编辑模式
    const setEditMode = useCallback(() => {
        setState((prev) => ({
            ...prev,
            isEditing: true,
        }));
    }, []);

    // 设置为预览模式
    const setPreviewMode = useCallback(() => {
        setState((prev) => ({
            ...prev,
            isEditing: false,
        }));
    }, []);

    // 注册路由变化前的确认
    useCallback(() => {
        const handleRouteChange = () => {
            if (state.hasUnsavedChanges) {
                const confirmed = window.confirm('您有未保存的更改，确定要离开吗？');
                if (!confirmed) {
                    router.events.emit('routeChangeError');
                    throw 'routeChange aborted';
                }
            }
        };

        router.events.on('routeChangeStart', handleRouteChange);

        return () => {
            router.events.off('routeChangeStart', handleRouteChange);
        };
    }, [router, state.hasUnsavedChanges]);

    // 注册页面关闭前的确认
    useCallback(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (state.hasUnsavedChanges) {
                e.preventDefault();
                e.returnValue = '';
                return '';
            }
        };

        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
        };
    }, [state.hasUnsavedChanges]);

    return {
        isEditing: state.isEditing,
        hasUnsavedChanges: state.hasUnsavedChanges,
        toggleEditMode,
        setHasUnsavedChanges,
        setEditMode,
        setPreviewMode,
    };
}
