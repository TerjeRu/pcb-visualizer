// The main window's first size. A fixed 1600×1000 is larger than a laptop screen with display scaling
// (1920×1080 at 125 % is 1536×864 logical pixels), so the size follows the primary monitor.

const WIDTH: f64 = 1600.0;
const HEIGHT: f64 = 1000.0;
const MIN_WIDTH: f64 = 1400.0;
const MIN_HEIGHT: f64 = 900.0;

#[derive(Debug, PartialEq)]
pub enum Initial {
    Maximized,
    Sized(f64, f64),
}

/// `screen` is the primary monitor's logical size. Unknown or small screens get a maximized window.
pub fn initial_size(screen: Option<(f64, f64)>) -> Initial {
    match screen {
        Some((width, height)) if width >= MIN_WIDTH && height >= MIN_HEIGHT => Initial::Sized(
            WIDTH.min((width * 0.9).floor()),
            HEIGHT.min((height * 0.9).floor()),
        ),
        _ => Initial::Maximized,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_or_small_screens_maximize() {
        assert_eq!(initial_size(None), Initial::Maximized);
        assert_eq!(initial_size(Some((1536.0, 864.0))), Initial::Maximized);
        assert_eq!(initial_size(Some((1280.0, 800.0))), Initial::Maximized);
    }

    #[test]
    fn larger_screens_get_the_default_capped_at_ninety_percent() {
        assert_eq!(
            initial_size(Some((1920.0, 1080.0))),
            Initial::Sized(1600.0, 972.0)
        );
        assert_eq!(
            initial_size(Some((2560.0, 1440.0))),
            Initial::Sized(1600.0, 1000.0)
        );
    }
}
