import { useCallback } from 'react';
import useFetcher from './fetcher';

interface DeleteData {
    id: string;
    permanent?: boolean;
}

interface RestoreData {
    id: string;
    parentId?: string;
}

// Use a discriminated union for better type safety
interface MutateBody {
    action: 'restore' | 'delete';
    data: DeleteData | RestoreData;
}

export default function useTrashAPI() {
    const { loading, request, abort } = useFetcher();

    const mutate = useCallback(
        async (body: MutateBody) => { // Body type is now more specific
            return request<MutateBody, undefined>( // Request body type is also specific
                {
                    method: 'POST',
                    url: `/api/trash`,
                },
                body
            );
        },
        [request]
    );

    return {
        loading,
        abort,
        mutate,
    };
}
