import { api } from 'libs/server/connect';
import { useAuth } from 'libs/server/middlewares/auth';
import { useStore } from 'libs/server/middlewares/store';

export default api()
    .use(useAuth)
    .use(useStore)
    .post(async (_req, res) => {
        // 图片上传功能已移除，返回错误信息
        res.status(400).json({ 
            error: '图片上传功能已禁用，请使用 Markdown 语法 ![](图片链接) 引用外部图片' 
        });
    });
