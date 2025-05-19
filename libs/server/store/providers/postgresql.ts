import { ObjectOptions, StoreProvider, StoreProviderConfig } from './base';
import { toBuffer, toStr } from 'libs/shared/str';
import { Pool, PoolClient } from 'pg';
import { isEmpty } from 'lodash';
import { createLogger, Logger } from 'libs/server/debugging';

export interface PostgreSQLConfig extends StoreProviderConfig {
    connectionString: string;
}

export class StorePostgreSQL extends StoreProvider {
    pool: Pool;
    config: PostgreSQLConfig;
    logger: Logger;
    initialized: boolean = false;

    constructor(config: PostgreSQLConfig) {
        super(config);
        this.logger = createLogger('store.postgresql');
        this.pool = new Pool({
            connectionString: config.connectionString,
        });
        this.config = config;
        this.initDatabase().catch(err => {
            this.logger.error(err, 'Failed to initialize PostgreSQL database');
        });
    }

    private async initDatabase() {
        if (this.initialized) return;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Create objects table
            await client.query(`
                CREATE TABLE IF NOT EXISTS objects (
                    path TEXT PRIMARY KEY,
                    content BYTEA,
                    is_compressed BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Create object_metadata table
            await client.query(`
                CREATE TABLE IF NOT EXISTS object_metadata (
                    path TEXT REFERENCES objects(path) ON DELETE CASCADE,
                    key TEXT NOT NULL,
                    value TEXT,
                    PRIMARY KEY (path, key)
                )
            `);

            // Create object_headers table
            await client.query(`
                CREATE TABLE IF NOT EXISTS object_headers (
                    path TEXT REFERENCES objects(path) ON DELETE CASCADE,
                    content_type TEXT,
                    cache_control TEXT,
                    content_disposition TEXT,
                    content_encoding TEXT,
                    PRIMARY KEY (path)
                )
            `);

            // Create indexes
            await client.query('CREATE INDEX IF NOT EXISTS idx_objects_path ON objects(path)');
            await client.query('CREATE INDEX IF NOT EXISTS idx_object_metadata_path ON object_metadata(path)');
            await client.query('CREATE INDEX IF NOT EXISTS idx_object_headers_path ON object_headers(path)');

            await client.query('COMMIT');
            this.initialized = true;
            this.logger.info('PostgreSQL database initialized successfully');
        } catch (err) {
            await client.query('ROLLBACK');
            this.logger.error(err, 'Error initializing PostgreSQL database');
            throw err;
        } finally {
            client.release();
        }
    }

    private async withClient<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
        await this.initDatabase();
        const client = await this.pool.connect();
        try {
            return await callback(client);
        } finally {
            client.release();
        }
    }

    private async withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
        return this.withClient(async (client) => {
            await client.query('BEGIN');
            try {
                const result = await callback(client);
                await client.query('COMMIT');
                return result;
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
        });
    }

    async getSignUrl(path: string, _expires = 600): Promise<string | null> {
        // PostgreSQL implementation doesn't need signed URLs
        // Return a direct path to the API endpoint that will serve the content
        return `/api/object/${encodeURIComponent(this.getPath(path))}`;
    }

    async hasObject(path: string): Promise<boolean> {
        try {
            return await this.withClient(async (client) => {
                // 使用类型断言而不是非空断言
                const result = await client.query(
                    'SELECT 1 FROM objects WHERE path = $1',
                    [this.getPath(path)]
                ) as { rowCount: number, rows: any[] };
                
                return result.rowCount > 0;
            });
        } catch (err) {
            this.logger.error(err, '检查对象是否存在失败: %s', path);
            return false;
        }
    }

    async getObject(path: string, isCompressed = false): Promise<string | undefined> {
        try {
            return await this.withClient(async (client) => {
                // 使用类型断言
                const result = await client.query(
                    'SELECT content, is_compressed FROM objects WHERE path = $1',
                    [this.getPath(path)]
                ) as { rowCount: number, rows: any[] };
                
                if (result.rowCount === 0) {
                    return undefined;
                }
                
                const { content, is_compressed } = result.rows[0];
                return toStr(content, is_compressed || isCompressed);
            });
        } catch (err) {
            this.logger.error(err, '获取对象失败: %s', path);
            return undefined;
        }
    }

    async getObjectMeta(path: string): Promise<{ [key: string]: string } | undefined> {
        try {
            return await this.withClient(async (client) => {
                // 使用类型断言
                const result = await client.query(
                    'SELECT key, value FROM object_metadata WHERE path = $1',
                    [this.getPath(path)]
                ) as { rowCount: number, rows: any[] };
                
                if (result.rowCount === 0) {
                    return undefined;
                }
                
                const meta: { [key: string]: string } = {};
                for (const row of result.rows) {
                    meta[row.key] = row.value;
                }
                
                return meta;
            });
        } catch (err) {
            this.logger.error(err, '获取对象元数据失败: %s', path);
            return undefined;
        }
    }

    async getObjectAndMeta(
        path: string,
        isCompressed = false
    ): Promise<{
        content?: string;
        meta?: { [key: string]: string };
        contentType?: string;
        buffer?: Buffer;
    }> {
        try {
            return await this.withClient(async (client) => {
                // 使用类型断言
                const objectResult = await client.query(
                    'SELECT content, is_compressed FROM objects WHERE path = $1',
                    [this.getPath(path)]
                ) as { rowCount: number, rows: any[] };
                
                if (objectResult.rowCount === 0) {
                    return {};
                }
                
                const { content, is_compressed } = objectResult.rows[0];
                
                // 使用类型断言
                const metaResult = await client.query(
                    'SELECT key, value FROM object_metadata WHERE path = $1',
                    [this.getPath(path)]
                ) as { rowCount: number, rows: any[] };
                
                const meta: { [key: string]: string } = {};
                for (const row of metaResult.rows) {
                    meta[row.key] = row.value;
                }
                
                // 使用类型断言
                const headerResult = await client.query(
                    'SELECT content_type FROM object_headers WHERE path = $1',
                    [this.getPath(path)]
                ) as { rowCount: number, rows: any[] };
                
                const contentType = headerResult.rowCount > 0 ? headerResult.rows[0].content_type : undefined;
                
                return {
                    content: toStr(content, is_compressed || isCompressed),
                    meta: Object.keys(meta).length > 0 ? meta : undefined,
                    contentType,
                    buffer: content
                };
            });
        } catch (err) {
            this.logger.error(err, '获取对象和元数据失败: %s', path);
            return {};
        }
    }

    async putObject(
        path: string,
        raw: string | Buffer,
        options?: ObjectOptions,
        isCompressed?: boolean
    ): Promise<void> {
        const fullPath = this.getPath(path);
        const content = Buffer.isBuffer(raw) ? raw : toBuffer(raw, isCompressed);
        
        try {
            return await this.withTransaction(async (client) => {
                // Insert or update object
                await client.query(
                    `INSERT INTO objects (path, content, is_compressed, updated_at)
                     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                     ON CONFLICT (path) 
                     DO UPDATE SET content = $2, is_compressed = $3, updated_at = CURRENT_TIMESTAMP`,
                    [fullPath, content, !!isCompressed]
                );
                
                // Handle metadata if provided
                if (options?.meta) {
                    // Delete existing metadata
                    await client.query('DELETE FROM object_metadata WHERE path = $1', [fullPath]);
                    
                    // Insert new metadata
                    for (const [key, value] of Object.entries(options.meta)) {
                        await client.query(
                            'INSERT INTO object_metadata (path, key, value) VALUES ($1, $2, $3)',
                            [fullPath, key, value]
                        );
                    }
                }
                
                // Handle headers if provided
                if (options?.contentType || options?.headers) {
                    await client.query(
                        `INSERT INTO object_headers (path, content_type, cache_control, content_disposition, content_encoding)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (path) 
                         DO UPDATE SET content_type = $2, cache_control = $3, content_disposition = $4, content_encoding = $5`,
                        [
                            fullPath,
                            options.contentType,
                            options.headers?.cacheControl,
                            options.headers?.contentDisposition,
                            options.headers?.contentEncoding
                        ]
                    );
                }
            });
        } catch (err) {
            this.logger.error(err, '保存对象失败: %s', path);
            throw err;
        }
    }

    async deleteObject(path: string): Promise<void> {
        try {
            return await this.withClient(async (client) => {
                // Due to CASCADE constraints, this will also delete related metadata and headers
                await client.query('DELETE FROM objects WHERE path = $1', [this.getPath(path)]);
            });
        } catch (err) {
            this.logger.error(err, '删除对象失败: %s', path);
            throw err;
        }
    }

    async copyObject(fromPath: string, toPath: string, options: ObjectOptions): Promise<void> {
        const sourceFullPath = this.getPath(fromPath);
        const targetFullPath = this.getPath(toPath);
        
        try {
            return await this.withTransaction(async (client) => {
                // Copy the object content
                // 使用类型断言
                const objectResult = await client.query(
                    'SELECT content, is_compressed FROM objects WHERE path = $1',
                    [sourceFullPath]
                ) as { rowCount: number, rows: any[] };
                
                if (objectResult.rowCount === 0) {
                    throw new Error(`Source object not found: ${fromPath}`);
                }
                
                const { content, is_compressed } = objectResult.rows[0];
                
                // Insert or update the target object
                await client.query(
                    `INSERT INTO objects (path, content, is_compressed, updated_at)
                     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                     ON CONFLICT (path) 
                     DO UPDATE SET content = $2, is_compressed = $3, updated_at = CURRENT_TIMESTAMP`,
                    [targetFullPath, content, is_compressed]
                );
                
                // Handle metadata
                if (isEmpty(options?.meta)) {
                    // Copy metadata from source if no new metadata provided
                    // 使用类型断言
                    const metaResult = await client.query(
                        'SELECT key, value FROM object_metadata WHERE path = $1',
                        [sourceFullPath]
                    ) as { rowCount: number, rows: any[] };
                    
                    // Delete existing metadata on target
                    await client.query('DELETE FROM object_metadata WHERE path = $1', [targetFullPath]);
                    
                    // Copy metadata to target
                    for (const row of metaResult.rows) {
                        await client.query(
                            'INSERT INTO object_metadata (path, key, value) VALUES ($1, $2, $3)',
                            [targetFullPath, row.key, row.value]
                        );
                    }
                } else {
                    // Use provided metadata
                    // Delete existing metadata
                    await client.query('DELETE FROM object_metadata WHERE path = $1', [targetFullPath]);
                    
                    // Insert new metadata
                    for (const [key, value] of Object.entries(options.meta)) {
                        await client.query(
                            'INSERT INTO object_metadata (path, key, value) VALUES ($1, $2, $3)',
                            [targetFullPath, key, value]
                        );
                    }
                }
                
                // Handle headers
                if (options?.contentType || options?.headers) {
                    // Use provided headers
                    await client.query(
                        `INSERT INTO object_headers (path, content_type, cache_control, content_disposition, content_encoding)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (path) 
                         DO UPDATE SET content_type = $2, cache_control = $3, content_disposition = $4, content_encoding = $5`,
                        [
                            targetFullPath,
                            options.contentType,
                            options.headers?.cacheControl,
                            options.headers?.contentDisposition,
                            options.headers?.contentEncoding
                        ]
                    );
                } else {
                    // Copy headers from source
                    // 使用类型断言
                    const headerResult = await client.query(
                        'SELECT content_type, cache_control, content_disposition, content_encoding FROM object_headers WHERE path = $1',
                        [sourceFullPath]
                    ) as { rowCount: number, rows: any[] };
                    
                    if (headerResult.rowCount > 0) {
                        const { content_type, cache_control, content_disposition, content_encoding } = headerResult.rows[0];
                    
                        await client.query(
                            `INSERT INTO object_headers (path, content_type, cache_control, content_disposition, content_encoding)
                             VALUES ($1, $2, $3, $4, $5)
                             ON CONFLICT (path) 
                             DO UPDATE SET content_type = $2, cache_control = $3, content_disposition = $4, content_encoding = $5`,
                            [targetFullPath, content_type, cache_control, content_disposition, content_encoding]
                        );
                    }
                }
            });
        } catch (err) {
            this.logger.error(err, '复制对象失败: %s -> %s', fromPath, toPath);
            throw err;
        }
    }
}
