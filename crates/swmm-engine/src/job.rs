//! Ties engine processes to the lifetime of this process.
//!
//! On Windows every engine is put in a job object created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The job handle is never closed by us: the system
//! closes it when this process ends — normal exit, crash or kill — and then terminates
//! every process left in the job, so no simulation outlives the application.

use std::process::Child;

#[cfg(windows)]
pub(crate) fn bind_to_parent(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // The handle is stored as an integer so that the static is `Sync`.
    static JOB: OnceLock<Option<usize>> = OnceLock::new();
    let job = JOB.get_or_init(|| {
        // SAFETY: plain Win32 calls on a handle we own; the info struct is fully initialised.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            (ok != 0).then_some(job as usize)
        }
    });
    if let Some(job) = *job {
        // SAFETY: both handles are valid for the duration of the call. Failure (e.g. the
        // process already ended) only loses the guarantee, not the run.
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn bind_to_parent(_child: &Child) {}

#[cfg(all(test, windows))]
mod tests {
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};

    #[test]
    fn engine_process_is_in_the_kill_on_close_job() {
        let mut child =
            Command::new("cmd").args(["/c", "ping", "-n", "30", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap();
        super::bind_to_parent(&child);
        let mut in_job = 0;
        // SAFETY: valid process handle; a null job handle asks about any job.
        let ok = unsafe {
            windows_sys::Win32::System::JobObjects::IsProcessInJob(
                child.as_raw_handle() as _,
                std::ptr::null_mut(),
                &mut in_job,
            )
        };
        let _ = child.kill();
        let _ = child.wait();
        assert!(ok != 0 && in_job != 0);
    }
}
