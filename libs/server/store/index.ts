import { StorePostgreSQL } from './providers/postgresql';
import { StoreProvider } from './providers/base';
import { config } from 'libs/server/config';

export function createStore(): StoreProvider {
    const cfg = config().store;
    return new StorePostgreSQL({
        connectionString: cfg.connectionString,
        prefix: cfg.prefix,
    });
}

export { StoreProvider } from './providers/base';
