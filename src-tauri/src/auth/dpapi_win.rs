use anyhow::Result;
use std::ptr;
use winapi::um::dpapi::CryptUnprotectData;
use winapi::um::wincrypt::DATA_BLOB;

pub fn decrypt_data(data: &[u8]) -> Result<Vec<u8>> {
    let mut input = DATA_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut _,
    };
    let mut output = DATA_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    unsafe {
        let result = CryptUnprotectData(
            &mut input,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            &mut output,
        );

        if result == 0 {
            return Err(anyhow::anyhow!("CryptUnprotectData failed"));
        }

        let decrypted = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        winapi::um::winbase::LocalFree(output.pbData as *mut _);
        Ok(decrypted)
    }
}
