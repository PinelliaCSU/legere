// 目录选择：弹出系统文件管理器窗口（Windows 的 IFileOpenDialog + FOS_PICKFOLDERS）。
//
// 为什么直接用 windows crate 的 COM 接口，而不是 tauri-plugin-dialog：
// 本机构建环境离线（cargo 源镜像不可达、npm 缓存不可写），加插件需要下载新依赖；
// 而 windows 已经是 tauri 的传递依赖并已缓存，复用它不引入任何新下载。

use crate::error::ApiError;

/// 弹出系统「选择文件夹」窗口。
///
/// `Ok(Some(path))` = 用户选了一个目录；`Ok(None)` = 用户取消；
/// `Err` = 平台不支持或调用失败（与「取消」区分开，前端要分两种提示）。
pub fn pick_folder() -> Result<Option<String>, ApiError> {
    imp::pick_folder()
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn pick_folder() -> Result<Option<String>, ApiError> {
        Err(ApiError::new(
            crate::error::ApiErrorCode::Unsupported,
            "当前环境不支持该功能",
            false,
        )
            .with_detail("目录选择窗口只实现了 Windows 后端"))
    }
}

#[cfg(windows)]
mod imp {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellItem, FILEOPENDIALOGOPTIONS, FOS_FORCEFILESYSTEM,
        FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };

    use super::*;

    /// 用户点「取消」时 Show() 返回的 HRESULT：HRESULT_FROM_WIN32(ERROR_CANCELLED)。
    const CANCELLED: u32 = 0x8007_04C7;

    pub fn pick_folder() -> Result<Option<String>, ApiError> {
        // 文件对话框是 COM 组件：必须在线程上初始化过 COM 才能调用。
        // RPC_E_CHANGED_MODE（线程已按别的套间初始化）不影响后续调用，故只看是否 S_OK。
        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let owned = hr.is_ok();
            let result = show_dialog();
            if owned {
                CoUninitialize();
            }
            result
        }
    }

    unsafe fn show_dialog() -> Result<Option<String>, ApiError> {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|err| ApiError::internal(format!("无法创建目录选择窗口: {err}")))?;

        let options = dialog
            .GetOptions()
            .map_err(|err| ApiError::internal(format!("无法读取对话框选项: {err}")))?;
        // 只选文件夹 + 只接受文件系统路径 + 目标必须存在：
        // 否则用户可能选中「此电脑 / 网络」这类没有磁盘路径的虚拟节点。
        let desired = FILEOPENDIALOGOPTIONS(
            options.0 | FOS_PICKFOLDERS.0 | FOS_FORCEFILESYSTEM.0 | FOS_PATHMUSTEXIST.0,
        );
        dialog
            .SetOptions(desired)
            .map_err(|err| ApiError::internal(format!("无法设置目录选择模式: {err}")))?;

        match dialog.Show(None) {
            Ok(()) => {}
            Err(err) if err.code().0 as u32 == CANCELLED => return Ok(None),
            Err(err) => return Err(ApiError::internal(format!("目录选择窗口失败: {err}"))),
        }

        let item: IShellItem = dialog
            .GetResult()
            .map_err(|err| ApiError::internal(format!("没有取到所选目录: {err}")))?;
        let raw = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|err| ApiError::internal(format!("所选目录不是文件系统路径: {err}")))?;
        let decoded = raw.to_string();
        CoTaskMemFree(Some(raw.0 as *const _));
        let path = decoded.map_err(|_| ApiError::internal("所选目录路径无法解码"))?;
        Ok(Some(path))
    }
}
