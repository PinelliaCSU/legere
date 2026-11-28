import { version } from "../../src-tauri/tauri.conf.json";
import brandIcon from "../../src-tauri/icons/128x128.png";

export function AboutPage() {
  return (
    <section className="lg-about" aria-labelledby="about-title">
      <article>
        <header>
          <img src={brandIcon} width="58" height="58" alt="" />
          <h1 id="about-title">Legere</h1>
          <span>版本 {version}</span>
        </header>
        <p className="lg-about-intro">一间放在自己电脑里的 PDF 阅览室。</p>
        <dl>
          <dt>本地阅读</dt>
          <dd>Legere 从你选择的文件夹读取 PDF。全文索引、书签和阅读进度保存在本机，日常阅读与检索可离线使用。</dd>
          <dt>项目与反馈</dt>
          <dd>项目由 PinelliaCSU 维护。你可以在 GitHub 查看源码、下载发布版本或提交问题。
            <a className="lg-project-link" href="https://github.com/PinelliaCSU/legere" target="_blank" rel="noopener noreferrer">
              <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              GitHub 项目主页
            </a>
          </dd>
          <dt>设计与致谢</dt>
          <dd>主页的草木线描受 <a href="https://github.com/kevinraymond/florilegium" target="_blank" rel="noopener noreferrer">Florilegium</a> 启发，由 Legere 在本地随机生成。PDF 页面由 Mozilla 的 PDF.js 渲染。</dd>
        </dl>
      </article>
    </section>
  );
}
