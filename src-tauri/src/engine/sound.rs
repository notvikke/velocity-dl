use log::error;
use rodio::{OutputStream, Sink, Source};

pub fn play_finish_sound() {
    std::thread::spawn(|| {
        if let Ok((_stream, stream_handle)) = OutputStream::try_default() {
            let Ok(sink) = Sink::try_new(&stream_handle) else {
                error!("Failed to create finish-sound sink");
                return;
            };

            // Generating a simple tone with rodio
            let source = rodio::source::SineWave::new(1000.0)
                .take_duration(std::time::Duration::from_millis(200))
                .amplify(0.2);

            sink.append(source);
            sink.sleep_until_end();
        } else {
            error!("Failed to get default output stream for sound");
        }
    });
}

pub fn play_error_sound() {
    std::thread::spawn(|| {
        if let Ok((_stream, stream_handle)) = OutputStream::try_default() {
            let Ok(sink) = Sink::try_new(&stream_handle) else {
                error!("Failed to create error-sound sink");
                return;
            };

            let source = rodio::source::SineWave::new(400.0)
                .take_duration(std::time::Duration::from_millis(300))
                .amplify(0.2);

            sink.append(source);
            sink.sleep_until_end();
        } else {
            error!("Failed to get default output stream for sound");
        }
    });
}
